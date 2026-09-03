import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPaymentIntegrationSafe } from "../../src/modules/settings/payment-integration.repo.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Stage 2 — Settings: Business (view/edit) and Payments (read-only status). */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

describe("Settings > Business", () => {
  it("any tenant user can read; only a tenant admin can write", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });

    const readMember = await h.api.get("/api/settings/business").set(...auth(carol.token));
    expect(readMember.status).toBe(200);
    expect(readMember.body.settings).toMatchObject({ businessName: "Acme Ltd" });
    expect(readMember.body.settings.invoiceDefaults.currency).toBe("EUR");

    const writeMember = await h.api
      .put("/api/settings/business")
      .set(...auth(carol.token))
      .send({ businessName: "Hacme" });
    expect(writeMember.status).toBe(403);

    const writeAdmin = await h.api
      .put("/api/settings/business")
      .set(...auth(h.tokens.alice))
      .send({ businessName: "Acme Trading Ltd", city: "Dublin", defaultDueDays: 30, invoiceNumberPrefix: "AC-" });
    expect(writeAdmin.status).toBe(200);
    expect(writeAdmin.body.settings).toMatchObject({ businessName: "Acme Trading Ltd" });
    expect(writeAdmin.body.settings.address.city).toBe("Dublin");
    expect(writeAdmin.body.settings.invoiceDefaults).toMatchObject({ dueDays: 30, numberPrefix: "AC-" });

    // the member now sees the admin's change
    const reRead = await h.api.get("/api/settings/business").set(...auth(carol.token));
    expect(reRead.body.settings.businessName).toBe("Acme Trading Ltd");
  });

  it("rejects unknown keys and invalid values", async () => {
    for (const body of [
      { businessName: "X", tenantId: h.ids.tenants.smith },
      { nextInvoiceNumber: 999 },
      { defaultDueDays: -1 },
      { contactEmail: "nope" },
    ]) {
      const res = await h.api.put("/api/settings/business").set(...auth(h.tokens.alice)).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("Tenant A cannot read or write Tenant B settings", async () => {
    await h.api.put("/api/settings/business").set(...auth(h.tokens.bob)).send({ businessName: "SMITH SECRET" });

    const acme = await h.api.get("/api/settings/business").set(...auth(h.tokens.alice));
    expect(acme.body.settings.businessName).not.toBe("SMITH SECRET");

    // direct DB layer: Acme's admin context sees only Acme's row
    const rows = await h.db.withContext(
      { userId: h.ids.users.alice, tenantId: h.ids.tenants.acme, isAdmin: false, tenantRole: "admin" },
      (q) => q.query<{ business_name: string }>("SELECT business_name FROM tenant_settings"),
    );
    expect(rows.rows.map((r) => r.business_name)).toEqual(["Acme Ltd"]);
  });

  it("a newly provisioned tenant gets a settings row", async () => {
    const created = await h.api.post("/api/admin/tenants").set(...auth(h.tokens.admin)).send({ name: "Fresh Co" });
    const tenantId = created.body.tenant.id;
    const rows = await h.db.privileged((q) =>
      q.query<{ n: number }>("SELECT count(*)::int n FROM tenant_settings WHERE tenant_id = $1", [tenantId]),
    );
    expect(rows.rows[0]!.n).toBe(1);
  });
});

describe("Settings > Payments (Fire.com) — read-only in Stage 2", () => {
  it("a tenant admin sees a 'not connected' status; there is no connect endpoint yet", async () => {
    const res = await h.api.get("/api/settings/payment-integration").set(...auth(h.tokens.alice));
    expect(res.status).toBe(200);
    expect(res.body.integration).toEqual({ provider: "fire", status: "not_connected" });
    expect(res.body.configurable).toBe(false);

    // no write endpoints exist
    expect((await h.api.put("/api/settings/payment-integration").set(...auth(h.tokens.alice)).send({})).status).toBe(404);
    expect((await h.api.post("/api/settings/payment-integration").set(...auth(h.tokens.alice)).send({})).status).toBe(404);
  });

  it("a member cannot reach the payments settings", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    expect((await h.api.get("/api/settings/payment-integration").set(...auth(carol.token))).status).toBe(403);
  });

  it("never returns credential ciphertext even when a row exists", async () => {
    // an admin context writes a row with ciphertext directly
    await h.db.withContext(
      { userId: h.ids.users.alice, tenantId: h.ids.tenants.acme, isAdmin: false, tenantRole: "admin" },
      (q) =>
        q.query(
          "INSERT INTO tenant_payment_integrations (tenant_id, status, client_key_ciphertext, refresh_token_ciphertext) VALUES ($1,'connected',$2,$2)",
          [h.ids.tenants.acme, Buffer.from("SUPER-SECRET-KEY")],
        ),
    );
    const res = await h.api.get("/api/settings/payment-integration").set(...auth(h.tokens.alice));
    expect(JSON.stringify(res.body)).not.toMatch(/ciphertext|SUPER-SECRET/i);
    expect(res.body.integration.status).toBe("connected");

    // the repo's own projection must not even fetch the secret columns
    const row = await h.db.withContext(
      { userId: h.ids.users.alice, tenantId: h.ids.tenants.acme, isAdmin: false, tenantRole: "admin" },
      (q) => getPaymentIntegrationSafe(q, h.ids.tenants.acme),
    );
    expect(Object.keys(row ?? {}).some((k) => k.includes("ciphertext"))).toBe(false);
  });

  it("Tenant A cannot read Tenant B's integration row", async () => {
    await h.db.withContext(
      { userId: h.ids.users.bob, tenantId: h.ids.tenants.smith, isAdmin: false, tenantRole: "admin" },
      (q) => q.query("INSERT INTO tenant_payment_integrations (tenant_id, fire_business_id) VALUES ($1, 'smith-biz')", [h.ids.tenants.smith]),
    );
    const res = await h.api.get("/api/settings/payment-integration").set(...auth(h.tokens.alice));
    expect(JSON.stringify(res.body)).not.toContain("smith-biz");
    expect(res.body.integration.status).toBe("not_connected");
  });
});
