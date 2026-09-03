import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FireClient } from "../../src/integrations/fire/index.ts";

/** Guards the Fire.com endpoint paths — a wrong base (/v1 vs /business/v1)
 *  silently 503s in production. */

const CREDS = { clientId: "cid", clientKey: "ckey", refreshToken: "rt" };
const BASE = "https://api.fire.test";

let calls: { url: string; method: string; body: unknown }[];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    const isAuth = url.endsWith("/apps/accesstokens");
    return new Response(
      JSON.stringify(
        isAuth
          ? { accessToken: "tok", expiry: new Date(Date.now() + 600_000).toISOString(), businessId: 1, apiApplicationId: 2, permissions: [] }
          : { code: "abc123", type: "OTHER", status: "PAID", amount: 100, total: 0, pisPaymentRequestPayments: [] },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("FireClient endpoint paths", () => {
  it("auth posts to /business/v1/apps/accesstokens with the right body", async () => {
    await new FireClient(CREDS, BASE).accessToken();
    expect(calls[0]!.url).toBe(`${BASE}/business/v1/apps/accesstokens`);
    expect(calls[0]!.body).toMatchObject({ clientId: "cid", refreshToken: "rt", grantType: "AccessToken" });
    // clientSecret is a sha256 hex of nonce+clientKey — present and 64 chars
    expect(String((calls[0]!.body as any).clientSecret)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("createPaymentRequest posts to /business/v1/paymentrequests", async () => {
    const r = await new FireClient(CREDS, BASE).createPaymentRequest({
      amountMinor: 100,
      currency: "EUR",
      myRef: "VD-000001",
      description: "VD-000001",
      icanTo: 74865,
    });
    expect(r.code).toBe("abc123");
    const pr = calls.find((c) => c.url.includes("/paymentrequests"))!;
    expect(pr.url).toBe(`${BASE}/business/v1/paymentrequests`);
    expect(pr.method).toBe("POST");
    expect(pr.body).toMatchObject({ type: "OTHER", icanTo: 74865, currency: "EUR", amount: 100, myRef: "VD-000001" });
  });

  it("getPaymentRequest gets /business/v1/paymentrequests/{code}", async () => {
    await new FireClient(CREDS, BASE).getPaymentRequest("abc123");
    expect(calls.some((c) => c.url === `${BASE}/business/v1/paymentrequests/abc123`)).toBe(true);
  });

  it("getPaymentRequestPayments gets /business/v2/paymentrequests/{code}/payments", async () => {
    await new FireClient(CREDS, BASE).getPaymentRequestPayments("abc123");
    expect(calls.some((c) => c.url === `${BASE}/business/v2/paymentrequests/abc123/payments`)).toBe(true);
  });

  it("caches the access token across calls", async () => {
    const c = new FireClient(CREDS, BASE);
    await c.getPaymentRequest("x");
    await c.getPaymentRequest("y");
    expect(calls.filter((k) => k.url.endsWith("/apps/accesstokens"))).toHaveLength(1);
  });
});
