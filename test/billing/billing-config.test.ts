import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getFirePlatformConfig } from "../../src/modules/billing/billing-config.repo.ts";
import { SYSTEM_CONTEXT } from "../../src/db/system-context.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const FIRE = {
  fireClientId: "cid-123",
  fireClientKey: "ckey-abc",
  fireRefreshToken: "refresh-xyz",
  fireWebhookPrivateToken: "wh-private-secret",
  fireWebhookKid: "wh-public-kid",
  fireCollectionIcan: 987654,
};

describe("admin billing config", () => {
  it("is admin-only", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "admin" });
    for (const token of [undefined, h.tokens.alice, carol.token]) {
      const req = h.api.get("/api/admin/billing/config");
      const res = await (token ? req.set(...auth(token)) : req);
      expect(res.status).toBe(token ? 403 : 401);
    }
    expect((await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.alice)).send({})).status).toBe(403);
  });

  it("returns defaults and accepts a business + timings update", async () => {
    const first = await h.api.get("/api/admin/billing/config").set(...auth(h.tokens.admin));
    expect(first.status).toBe(200);
    expect(first.body.config).toMatchObject({
      defaultCurrency: "EUR",
      renewalReminderDays: 7,
      fire: { configured: false, hasClientId: false },
    });

    const upd = await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.admin)).send({
      businessName: "VibeDev Ltd",
      businessAddress: "1 Main St, Naas",
      defaultCurrency: "GBP",
      renewalReminderDays: 10,
      overdueGraceDays: 3,
    });
    expect(upd.status).toBe(200);
    expect(upd.body.config).toMatchObject({
      businessName: "VibeDev Ltd",
      defaultCurrency: "GBP",
      renewalReminderDays: 10,
      overdueGraceDays: 3,
    });
  });

  it("rejects unknown keys and bad values", async () => {
    for (const body of [
      { nope: 1 },
      { defaultCurrency: "USD" },
      { renewalReminderDays: -1 },
      { businessContactEmail: "not-an-email" },
    ]) {
      const res = await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.admin)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("stores Fire credentials encrypted and never echoes them back", async () => {
    const res = await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.admin)).send(FIRE);
    expect(res.status).toBe(200);
    expect(res.body.config.fire).toMatchObject({
      hasClientId: true,
      hasClientKey: true,
      hasRefreshToken: true,
      hasWebhookPrivate: true,
      configured: true,
    });
    expect(res.body.config.fireWebhookKid).toBe("wh-public-kid");
    expect(res.body.config.fireCollectionIcan).toBe("987654");

    // No secret value anywhere in the response.
    const json = JSON.stringify(res.body);
    for (const secret of ["cid-123", "ckey-abc", "refresh-xyz", "wh-private-secret"]) {
      expect(json).not.toContain(secret);
    }

    // Stored column must be bytea ciphertext, not the plaintext bytes.
    const raw = await h.db.privileged((q) =>
      q.query<{ hex: string; len: number }>(
        "SELECT encode(fire_client_key_ciphertext, 'hex') AS hex, octet_length(fire_client_key_ciphertext) AS len FROM platform_billing_config WHERE id = 1",
      ),
    );
    expect(raw.rows[0]!.hex).not.toBe(Buffer.from("ckey-abc").toString("hex"));
    expect(Number(raw.rows[0]!.len)).toBeGreaterThan("ckey-abc".length + 28); // 1 ver + 12 iv + 16 tag
  });

  it("sets configured only when every credential + ICAN is present", async () => {
    await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.admin)).send({
      fireClientId: "a", fireClientKey: "b", fireRefreshToken: "c", fireWebhookPrivateToken: "d",
    });
    const res = await h.api.get("/api/admin/billing/config").set(...auth(h.tokens.admin));
    expect(res.body.config.fire.configured).toBe(false); // no ICAN yet
  });

  it("decrypts to the original values for the server-side FireClient", async () => {
    await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.admin)).send(FIRE);
    const creds = await h.db.withContext(SYSTEM_CONTEXT, (q) => getFirePlatformConfig(q));
    expect(creds).toMatchObject({
      clientId: "cid-123",
      clientKey: "ckey-abc",
      refreshToken: "refresh-xyz",
      webhookPrivateToken: "wh-private-secret",
      webhookKid: "wh-public-kid",
      collectionIcan: 987654,
    });
  });

  it("partial credential update keeps the untouched secrets", async () => {
    await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.admin)).send(FIRE);
    await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.admin)).send({ fireClientId: "cid-NEW" });
    const creds = await h.db.withContext(SYSTEM_CONTEXT, (q) => getFirePlatformConfig(q));
    expect(creds).toMatchObject({ clientId: "cid-NEW", clientKey: "ckey-abc", refreshToken: "refresh-xyz" });
  });
});

describe("Fire webhook endpoint", () => {
  it("503s until billing is configured", async () => {
    const res = await h.api.post("/api/webhooks/fire").set("Content-Type", "text/plain").send("x.y.z");
    expect(res.status).toBe(503);
  });

  it("401s a bad signature and 200s a valid one; both are audited", async () => {
    await h.api.put("/api/admin/billing/config").set(...auth(h.tokens.admin)).send(FIRE);

    const bad = await h.api.post("/api/webhooks/fire").set("Content-Type", "text/plain").send("not-a-jwt");
    expect(bad.status).toBe(401);

    const token = jwt.sign(
      { events: [{ type: "PAYMENT_REQUEST_PAYMENT_RECEIVED", paymentUuid: "p1" }] },
      "wh-private-secret",
      { algorithm: "HS256", keyid: "wh-public-kid" },
    );
    const ok = await h.api.post("/api/webhooks/fire").set("Content-Type", "application/jwt").send(token);
    expect(ok.status).toBe(200);
    expect(ok.body.received).toBe(1);

    const audit = await h.db.withContext(SYSTEM_CONTEXT, (q) =>
      q.query<{ action: string }>("SELECT action FROM audit_logs WHERE action LIKE 'billing.webhook%'"),
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).toContain("billing.webhook_received");
    expect(actions).toContain("billing.webhook_failed");
  });
});
