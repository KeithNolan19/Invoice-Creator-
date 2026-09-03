import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Stage 2 — the tenant-user dashboard. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

/** Force a specific state onto some invoices for one tenant (privileged, bypasses RLS). */
async function shapeInvoices() {
  await h.db.privileged(async (q) => {
    const acme = h.ids.tenants.acme;
    // ACME-0001 -> issued & overdue; ACME-0002 -> issued & pending, not overdue
    await q.query(
      `UPDATE invoices SET status='sent', payment_status='unpaid', due_on = current_date - 5
         WHERE tenant_id=$1 AND number='ACME-0001'`, [acme]);
    await q.query(
      `UPDATE invoices SET status='sent', payment_status='pending', due_on = current_date + 10
         WHERE tenant_id=$1 AND number='ACME-0002'`, [acme]);
    // a recently-paid invoice for Acme
    await q.query(
      `INSERT INTO invoices (tenant_id, number, client_name, amount_cents, subtotal_cents, total_cents,
                             currency, status, payment_status, paid_at, paid_amount_cents, paid_currency, issued_on)
       VALUES ($1,'ACME-9000','Paid Co',50000,50000,50000,'EUR','paid','paid', now() - interval '2 days', 50000, 'EUR', current_date - 3)`,
      [acme]);
  });
}

describe("dashboard counts", () => {
  it("summarises the caller's own tenant only", async () => {
    await shapeInvoices();
    const d = await h.api.get("/api/dashboard").set(...auth(h.tokens.alice));
    expect(d.status).toBe(200);

    expect(d.body.outstanding.count).toBe(2); // both ACME-0001 & 0002 are issued+unpaid/pending
    expect(d.body.pending.count).toBe(1);
    expect(d.body.overdue.count).toBe(1);
    expect(d.body.paidLast30Days).toMatchObject({ count: 1, totalCents: 50000 });
    expect(d.body.drafts.count).toBe(0);
    expect(d.body.totals.invoices).toBe(3);

    expect(d.body.recentInvoices.length).toBe(3);
    expect(d.body.recentInvoices[0]).toHaveProperty("paymentStatus");
    expect(d.body.recentPayments.map((i: any) => i.number)).toEqual(["ACME-9000"]);

    // Smith's dashboard is independent
    const s = await h.api.get("/api/dashboard").set(...auth(h.tokens.bob));
    expect(s.body.totals.invoices).toBe(1);
    expect(s.body.recentPayments.map((i: any) => i.number)).toEqual(["SMITH-0001"]);
    expect(s.body.overdue.count).toBe(0);
  });

  it("reports payment-integration status; only an admin can manage it", async () => {
    const admin = await h.api.get("/api/dashboard").set(...auth(h.tokens.alice));
    expect(admin.body.paymentIntegration).toEqual({ status: "not_connected", manageable: true });

    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    const member = await h.api.get("/api/dashboard").set(...auth(carol.token));
    expect(member.body.paymentIntegration).toEqual({ status: "not_connected", manageable: false });
  });

  it("a brand-new tenant shows an all-zero dashboard", async () => {
    const created = await h.api.post("/api/admin/tenants").set(...auth(h.tokens.admin)).send({ name: "Empty Co" });
    const user = await h.api
      .post(`/api/admin/tenants/${created.body.tenant.id}/users`)
      .set(...auth(h.tokens.admin))
      .send({ name: "Owner", email: "owner@empty.test" });
    const login = await h.api
      .post("/api/auth/login")
      .send({ email: "owner@empty.test", password: user.body.temporaryPassword });

    const d = await h.api.get("/api/dashboard").set(...auth(login.body.token));
    expect(d.body.totals).toEqual({ invoices: 0, customers: 0 });
    expect(d.body.outstanding.count).toBe(0);
    expect(d.body.recentInvoices).toEqual([]);
  });
});

describe("dashboard access control", () => {
  it("401 unauthenticated, 403 for a platform admin", async () => {
    expect((await h.api.get("/api/dashboard")).status).toBe(401);
    expect((await h.api.get("/api/dashboard").set(...auth(h.tokens.admin))).status).toBe(403);
  });

  it("blocked for a disabled user / suspended tenant", async () => {
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...auth(h.tokens.admin));
    expect((await h.api.get("/api/dashboard").set(...auth(h.tokens.alice))).status).toBe(403);
  });
});
