import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, RlsContext } from "../../src/db/types.ts";
import {
  insertCustomer,
  listCustomers,
  serializeCustomer,
  updateCustomer,
} from "../../src/modules/customers/customers.repo.ts";
import { replaceLineItems } from "../../src/modules/invoices/line-items.repo.ts";
import { getPaymentIntegrationSafe } from "../../src/modules/settings/payment-integration.repo.ts";
import { getTenantSettings, updateBusinessSettings } from "../../src/modules/settings/settings.repo.ts";
import { createHarness, type Harness } from "../support/harness.ts";

/**
 * Stage 1 — PostgreSQL RLS remains the enforcement mechanism for every
 * tenant-owned table, old and new. Exercised directly through `withContext`
 * (the same seam the HTTP layer uses) so the guarantee is proven at the
 * database layer, not the application layer.
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const acme = (role: "admin" | "member" = "admin"): RlsContext => ({
  userId: h.ids.users.alice,
  tenantId: h.ids.tenants.acme,
  isAdmin: false,
  tenantRole: role,
});
const smith = (role: "admin" | "member" = "admin"): RlsContext => ({
  userId: h.ids.users.bob,
  tenantId: h.ids.tenants.smith,
  isAdmin: false,
  tenantRole: role,
});
const noTenant = (): RlsContext => ({
  userId: h.ids.users.alice,
  tenantId: null,
  isAdmin: false,
  tenantRole: null,
});

let acmeCustomerId = "";
let smithCustomerId = "";
let acmeInvoiceId = "";
let smithInvoiceId = "";

beforeEach(async () => {
  await h.reload();
  acmeInvoiceId = h.ids.invoices.acme[0]!;
  smithInvoiceId = h.ids.invoices.smith[0]!;

  acmeCustomerId = (
    await h.db.withContext(acme(), (q) => insertCustomer(q, h.ids.tenants.acme, h.ids.users.alice, { name: "Acme Buyer", email: "buyer@acme-buyer.test" }))
  ).id;
  smithCustomerId = (
    await h.db.withContext(smith(), (q) => insertCustomer(q, h.ids.tenants.smith, h.ids.users.bob, { name: "Smith Buyer", email: "buyer@smith-buyer.test" }))
  ).id;

  await h.db.withContext(acme(), (q) =>
    replaceLineItems(q, acmeInvoiceId, h.ids.tenants.acme, [
      { description: "Acme work", quantity: 2, unitPriceCents: 5000, lineTotalCents: 10000 },
    ]),
  );
  await h.db.withContext(smith(), (q) =>
    replaceLineItems(q, smithInvoiceId, h.ids.tenants.smith, [
      { description: "Smith work", quantity: 1, unitPriceCents: 9900, lineTotalCents: 9900 },
    ]),
  );

  // one Fire.com integration row per tenant (admin context)
  for (const [ctx, tid] of [
    [acme(), h.ids.tenants.acme],
    [smith(), h.ids.tenants.smith],
  ] as const) {
    await h.db.withContext(ctx, (q) =>
      q.query("INSERT INTO tenant_payment_integrations (tenant_id, status) VALUES ($1, 'pending')", [tid]),
    );
  }

  await h.db.withContext(acme(), (q) =>
    updateBusinessSettings(q, h.ids.tenants.acme, { contactPhone: "ACME-PHONE" }),
  );
  await h.db.withContext(smith(), (q) =>
    updateBusinessSettings(q, h.ids.tenants.smith, { contactPhone: "SMITH-PHONE" }),
  );
});

const count = (q: Queryable, table: string) =>
  q.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`).then((r) => r.rows[0]!.n);

describe("a tenant sees only its own rows (both directions)", () => {
  it("customers", async () => {
    const acmeList = await h.db.withContext(acme("member"), (q) => listCustomers(q));
    expect(acmeList.map((c) => c.id)).toEqual([acmeCustomerId]);
    const smithList = await h.db.withContext(smith("member"), (q) => listCustomers(q));
    expect(smithList.map((c) => c.id)).toEqual([smithCustomerId]);
  });

  it("invoice_line_items", async () => {
    const a = await h.db.withContext(acme("member"), (q) =>
      q.query<{ description: string }>("SELECT description FROM invoice_line_items"),
    );
    expect(a.rows.map((r) => r.description)).toEqual(["Acme work"]);
    const s = await h.db.withContext(smith("member"), (q) =>
      q.query<{ description: string }>("SELECT description FROM invoice_line_items"),
    );
    expect(s.rows.map((r) => r.description)).toEqual(["Smith work"]);
  });

  it("tenant_settings", async () => {
    const a = await h.db.withContext(acme("member"), (q) => getTenantSettings(q, h.ids.tenants.acme));
    expect(a?.contact_phone).toBe("ACME-PHONE");
    // Acme's context cannot read Smith's settings row even by asking for it
    const crossRead = await h.db.withContext(acme("member"), (q) => getTenantSettings(q, h.ids.tenants.smith));
    expect(crossRead).toBeNull();
    expect(await h.db.withContext(acme("admin"), (q) => count(q, "tenant_settings"))).toBe(1);
  });

  it("tenant_payment_integrations — admins of their own tenant only", async () => {
    expect(await h.db.withContext(acme("admin"), (q) => count(q, "tenant_payment_integrations"))).toBe(1);
    expect(await h.db.withContext(smith("admin"), (q) => count(q, "tenant_payment_integrations"))).toBe(1);
    // a member of the tenant sees none; the other tenant's admin sees none
    expect(await h.db.withContext(acme("member"), (q) => count(q, "tenant_payment_integrations"))).toBe(0);
    const acmeRowForSmith = await h.db.withContext(smith("admin"), (q) =>
      getPaymentIntegrationSafe(q, h.ids.tenants.acme),
    );
    expect(acmeRowForSmith).toBeNull();
  });

  it("users", async () => {
    const a = await h.db.withContext(acme("member"), (q) =>
      q.query<{ email: string }>("SELECT email FROM users"),
    );
    expect(a.rows.map((r) => r.email)).toEqual(["alice@acme.test"]);
    const s = await h.db.withContext(smith("member"), (q) =>
      q.query<{ email: string }>("SELECT email FROM users"),
    );
    expect(s.rows.map((r) => r.email)).toEqual(["bob@smith.test"]);
  });
});

describe("no tenant context -> zero rows (fail closed)", () => {
  it("every new tenant-owned table", async () => {
    const counts = await h.db.withContext(noTenant(), async (q) => ({
      customers: await count(q, "customers"),
      lineItems: await count(q, "invoice_line_items"),
      settings: await count(q, "tenant_settings"),
      integrations: await count(q, "tenant_payment_integrations"),
    }));
    expect(counts).toEqual({ customers: 0, lineItems: 0, settings: 0, integrations: 0 });
  });
});

describe("WITH CHECK blocks writing into another tenant", () => {
  it("a repo called with the wrong tenant id still cannot create a cross-tenant customer", async () => {
    await expect(
      h.db.withContext(acme(), (q) =>
        insertCustomer(q, h.ids.tenants.smith, h.ids.users.alice, { name: "smuggled" }),
      ),
    ).rejects.toThrow(/row-level security/i);
    // Smith is unaffected
    const smithList = await h.db.withContext(smith("member"), (q) => listCustomers(q));
    expect(smithList.map((c) => c.name)).toEqual(["Smith Buyer"]);
  });

  it("cannot move an existing customer into another tenant", async () => {
    await expect(
      h.db.withContext(acme(), (q) =>
        q.query("UPDATE customers SET tenant_id = $1 WHERE id = $2", [h.ids.tenants.smith, acmeCustomerId]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a line item cannot be attached to another tenant's invoice", async () => {
    // via the repo (RLS blocks the WITH CHECK on tenant_id, and the FK on the invoice)
    await expect(
      h.db.withContext(acme(), (q) =>
        replaceLineItems(q, smithInvoiceId, h.ids.tenants.acme, [
          { description: "x", quantity: 1, unitPriceCents: 1, lineTotalCents: 1 },
        ]),
      ),
    ).rejects.toThrow();
    const smithItems = await h.db.withContext(smith("member"), (q) =>
      q.query<{ description: string }>("SELECT description FROM invoice_line_items"),
    );
    expect(smithItems.rows.map((r) => r.description)).toEqual(["Smith work"]);
  });

  it("a member cannot write tenant_settings; a cross-tenant admin cannot either", async () => {
    const asMember = await h.db.withContext(acme("member"), (q) =>
      q.query("UPDATE tenant_settings SET contact_phone = 'HACK' WHERE tenant_id = $1", [h.ids.tenants.acme]),
    );
    expect(asMember.rowCount).toBe(0);
    const crossTenant = await h.db.withContext(smith("admin"), (q) =>
      q.query("UPDATE tenant_settings SET contact_phone = 'HACK' WHERE tenant_id = $1", [h.ids.tenants.acme]),
    );
    expect(crossTenant.rowCount).toBe(0);

    const check = await h.db.withContext(acme("member"), (q) => getTenantSettings(q, h.ids.tenants.acme));
    expect(check?.contact_phone).toBe("ACME-PHONE");
  });
});

describe("cross-tenant DELETE affects nothing", () => {
  it("customers / line items / integrations", async () => {
    const c = await h.db.withContext(acme(), (q) =>
      q.query("DELETE FROM customers WHERE tenant_id = $1", [h.ids.tenants.smith]),
    );
    const l = await h.db.withContext(acme(), (q) =>
      q.query("DELETE FROM invoice_line_items WHERE tenant_id = $1", [h.ids.tenants.smith]),
    );
    const i = await h.db.withContext(acme(), (q) =>
      q.query("DELETE FROM tenant_payment_integrations WHERE tenant_id = $1", [h.ids.tenants.smith]),
    );
    expect([c.rowCount, l.rowCount, i.rowCount]).toEqual([0, 0, 0]);

    const stillThere = await h.db.privileged(async (q) => ({
      customers: await count(q, "customers"),
      lineItems: await count(q, "invoice_line_items"),
      integrations: await count(q, "tenant_payment_integrations"),
    }));
    expect(stillThere).toEqual({ customers: 2, lineItems: 2, integrations: 2 });
  });
});

describe("the safe integration projection never leaks ciphertext", () => {
  it("serializer and safe reader expose no secret columns", async () => {
    // put ciphertext into the row
    await h.db.privileged((q) =>
      q.query(
        `UPDATE tenant_payment_integrations
            SET client_key_ciphertext = $1, refresh_token_ciphertext = $1, webhook_secret_ciphertext = $1,
                fire_business_id = 'biz_123'
          WHERE tenant_id = $2`,
        [Buffer.from("TOP-SECRET"), h.ids.tenants.acme],
      ),
    );
    const safe = await h.db.withContext(acme("admin"), (q) =>
      getPaymentIntegrationSafe(q, h.ids.tenants.acme),
    );
    const json = JSON.stringify(safe);
    expect(json).not.toMatch(/ciphertext|SECRET/i);
    expect(safe).not.toHaveProperty("client_key_ciphertext");
    expect(safe?.fire_business_id).toBe("biz_123");
  });
});

describe("customer serializer shape", () => {
  it("round-trips address + never includes tenant internals beyond tenantId", async () => {
    const row = await h.db.withContext(acme(), (q) =>
      updateCustomer(q, acmeCustomerId, { city: "Dublin", country: "IE" }),
    );
    const s = serializeCustomer(row!);
    expect(s.address).toMatchObject({ city: "Dublin", country: "IE" });
    expect(s.tenantId).toBe(h.ids.tenants.acme);
  });
});
