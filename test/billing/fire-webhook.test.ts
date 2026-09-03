import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { FireWebhookError, verifyFireWebhook } from "../../src/integrations/fire/index.ts";

const PRIVATE = "fire-webhook-private-token-xyz";
const KID = "fire-webhook-public-token-abc";

const sign = (payload: object, opts: jwt.SignOptions = {}) =>
  jwt.sign(payload, PRIVATE, { algorithm: "HS256", keyid: KID, ...opts });

describe("verifyFireWebhook", () => {
  it("accepts a valid HS256 JWT and unwraps { events: [...] }", () => {
    const token = sign({ events: [{ type: "PAYMENT_REQUEST_PAYMENT_RECEIVED", paymentUuid: "p1" }] });
    const events = verifyFireWebhook(token, PRIVATE, KID);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("PAYMENT_REQUEST_PAYMENT_RECEIVED");
  });

  it("unwraps { data: [...] } and a bare single event object", () => {
    expect(verifyFireWebhook(sign({ data: [{ type: "A" }, { type: "B" }] }), PRIVATE)).toHaveLength(2);
    expect(verifyFireWebhook(sign({ type: "SINGLE" }), PRIVATE)[0]!.type).toBe("SINGLE");
  });

  it("rejects a JWT signed with the wrong secret", () => {
    const bad = jwt.sign({ events: [{ type: "X" }] }, "not-the-private-token", { algorithm: "HS256", keyid: KID });
    expect(() => verifyFireWebhook(bad, PRIVATE, KID)).toThrow(FireWebhookError);
  });

  it("rejects a kid that does not match the configured public token", () => {
    const token = jwt.sign({ events: [{ type: "X" }] }, PRIVATE, { algorithm: "HS256", keyid: "someone-elses-kid" });
    expect(() => verifyFireWebhook(token, PRIVATE, KID)).toThrow(/kid/i);
  });

  it("rejects a non-JWT body", () => {
    expect(() => verifyFireWebhook("not a jwt", PRIVATE)).toThrow(/no JWT/i);
    expect(() => verifyFireWebhook("{}", PRIVATE)).toThrow(/no JWT/i);
  });

  it("rejects an alg-none / unsigned token", () => {
    const none = jwt.sign({ events: [{ type: "X" }] }, "", { algorithm: "none", keyid: KID });
    expect(() => verifyFireWebhook(none, PRIVATE, KID)).toThrow(FireWebhookError);
  });

  it("still accepts an expired JWT (retries outlive the token; replay guarded downstream)", () => {
    const token = sign({ events: [{ type: "LATE" }] }, { expiresIn: -3600 });
    expect(verifyFireWebhook(token, PRIVATE, KID)[0]!.type).toBe("LATE");
  });

  it("accepts the JWT wrapped in a JSON envelope", () => {
    const token = sign({ type: "WRAPPED" });
    expect(verifyFireWebhook(JSON.stringify({ payload: token }), PRIVATE, KID)[0]!.type).toBe("WRAPPED");
  });
});
