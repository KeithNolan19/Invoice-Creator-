import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runBillingTick } from "../../src/billing/billing-tick.ts";
import { applyConfirmedPayment } from "../../src/billing/apply-payment.ts";
import { getPlanByCode } from "../../src/modules/billing/plans.repo.ts";
import { setSubscription, getSubscriptionForTenant } from "../../src/modules/billing/subscriptions.repo.ts";
import { listPlatformInvoices } from "../../src/modules/billing/platform-invoices.repo.ts";
import { listNotifications } from "../../src/modules/billing/notifications.repo.ts";
import { SYSTEM_CONTEXT } from "../../src/db/system-context.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const sys = SYSTEM_CONTEXT;

/** Put a tenant on the €1/day test plan with a renewal due `daysFromNow` away. */
async function onTestPlan(tenantId: string, renewalOffsetDays = 0) {
  return h.db.withContext(sys, async (q) => {
    const plan = (await getPlanByCode(q, "test-daily"))!;
    await setSubscription(q, { tenantId, planId: plan.id, billingInterval: "day", createdBy: h.ids.users.admin });
    // shift the renewal date to control when the tick acts
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + renewalOffsetDays);
    const iso = d.toISOString().slice(0, 10);
    await q.query(
      `UPDATE tenant_subscriptions SET current_period_start = $2, current_period_end = $2, renewal_date = $2 WHERE tenant_id = $1`,
      [tenantId, iso],
    );
    return iso;
  });
}

describe("billing tick — renewal generation", () => {
  it("generates one issued invoice inside the reminder window, and is idempotent", async () => {
    // test-daily has a 60-minute lead; a renewal 'today' is inside the window.
    await onTestPlan(h.ids.tenants.acme, 0);

    const r1 = await runBillingTick(h.db);
    expect(r1.renewalsGenerated).toBe(1);

    const r2 = await runBillingTick(h.db);
    expect(r2.renewalsGenerated).toBe(0); // marker + unique index

    const invoices = await h.db.withContext(sys, (q) => listPlatformInvoices(q, { tenantId: h.ids.tenants.acme }));
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe("issued"); // no Fire configured -> stays issued
    expect(Number(invoices[0]!.amount_cents)).toBe(100);

    const notifs = await h.db.withContext(sys, (q) => listNotifications(q));
    expect(notifs.some((n) => n.type === "renewal_invoice_generated")).toBe(true);
  });

  it("does NOT generate before the reminder window opens", async () => {
    await onTestPlan(h.ids.tenants.acme, 5); // renews in 5 days, lead is 60 min
    const r = await runBillingTick(h.db);
    expect(r.renewalsGenerated).toBe(0);
  });

  it("flags an overdue invoice", async () => {
    await onTestPlan(h.ids.tenants.acme, 0);
    await runBillingTick(h.db); // creates the issued invoice, due today

    // move its due date into the past
    await h.db.withContext(sys, (q) =>
      q.query("UPDATE platform_invoices SET due_date = current_date - 3 WHERE tenant_id = $1", [h.ids.tenants.acme]),
    );
    const r = await runBillingTick(h.db);
    expect(r.overdueFlagged).toBe(1);

    // deduped on a second run
    const r2 = await runBillingTick(h.db);
    expect(r2.overdueFlagged).toBe(0);
  });
});

describe("applyConfirmedPayment", () => {
  async function issuedInvoice(tenantId: string) {
    await onTestPlan(tenantId, 0);
    await runBillingTick(h.db);
    const [inv] = await h.db.withContext(sys, (q) => listPlatformInvoices(q, { tenantId }));
    return inv!;
  }

  it("marks the invoice paid, records the payment, advances the period, notifies — once", async () => {
    const inv = await issuedInvoice(h.ids.tenants.acme);
    const subBefore = await h.db.withContext(sys, (q) => getSubscriptionForTenant(q, h.ids.tenants.acme));

    const out = await applyConfirmedPayment(h.db, {
      invoiceId: inv.id,
      amountCents: 100,
      currency: "EUR",
      providerPaymentId: "pay-1",
      source: "manual",
    });
    expect(out).toBe("applied");

    // idempotent
    expect(
      await applyConfirmedPayment(h.db, { invoiceId: inv.id, amountCents: 100, currency: "EUR", source: "reconciliation" }),
    ).toBe("already_applied");

    const [after] = await h.db.withContext(sys, (q) => listPlatformInvoices(q, { tenantId: h.ids.tenants.acme }));
    expect(after!.status).toBe("paid");

    const pay = await h.db.withContext(sys, (q) =>
      q.query<{ n: number }>("SELECT count(*)::int n FROM platform_payments WHERE invoice_id = $1", [inv.id]),
    );
    expect(pay.rows[0]!.n).toBe(1);

    const subAfter = await h.db.withContext(sys, (q) => getSubscriptionForTenant(q, h.ids.tenants.acme));
    expect(subAfter!.renewal_date > subBefore!.renewal_date).toBe(true); // rolled forward one day

    const notifs = await h.db.withContext(sys, (q) => listNotifications(q));
    expect(notifs.some((n) => n.type === "client_paid")).toBe(true);
  });

  it("auto-reactivates a tenant suspended for non-payment, but not one suspended for 'other'", async () => {
    // Acme suspended for unpaid
    const invA = await issuedInvoice(h.ids.tenants.acme);
    await h.db.withContext(sys, (q) =>
      q.query("UPDATE tenants SET status='suspended', suspension_reason='unpaid' WHERE id=$1", [h.ids.tenants.acme]),
    );
    await applyConfirmedPayment(h.db, { invoiceId: invA.id, amountCents: 100, currency: "EUR", source: "manual" });
    const acme = await h.db.withContext(sys, (q) =>
      q.query<{ status: string; reactivated_at: string | null }>("SELECT status, reactivated_at FROM tenants WHERE id=$1", [h.ids.tenants.acme]),
    );
    expect(acme.rows[0]!.status).toBe("active");
    expect(acme.rows[0]!.reactivated_at).not.toBeNull();

    // Smith suspended for 'other' — stays suspended
    const invS = await issuedInvoice(h.ids.tenants.smith);
    await h.db.withContext(sys, (q) =>
      q.query("UPDATE tenants SET status='suspended', suspension_reason='other' WHERE id=$1", [h.ids.tenants.smith]),
    );
    await applyConfirmedPayment(h.db, { invoiceId: invS.id, amountCents: 100, currency: "EUR", source: "manual" });
    const smith = await h.db.withContext(sys, (q) =>
      q.query<{ status: string }>("SELECT status FROM tenants WHERE id=$1", [h.ids.tenants.smith]),
    );
    expect(smith.rows[0]!.status).toBe("suspended");
  });

  it("under-payment does not mark the invoice paid", async () => {
    const inv = await issuedInvoice(h.ids.tenants.acme);
    const out = await applyConfirmedPayment(h.db, { invoiceId: inv.id, amountCents: 50, currency: "EUR", source: "manual" });
    expect(out).toBe("amount_mismatch");
    const [after] = await h.db.withContext(sys, (q) => listPlatformInvoices(q, { tenantId: h.ids.tenants.acme }));
    expect(after!.status).not.toBe("paid");
  });
});

describe("admin billing routes — access + a full loop over HTTP", () => {
  it("tenant users cannot reach /api/admin/billing/*", async () => {
    expect((await h.api.get("/api/admin/billing/plans").set(...auth(h.tokens.alice))).status).toBe(403);
    expect((await h.api.get("/api/admin/billing/summary")).status).toBe(401);
  });

  it("assign the test plan, run the tick, record a payment, period advances", async () => {
    const plans = (await h.api.get("/api/admin/billing/plans").set(...auth(h.tokens.admin))).body.plans;
    const testPlan = plans.find((p: any) => p.code === "test-daily");

    const assigned = await h.api
      .put(`/api/admin/billing/tenants/${h.ids.tenants.acme}/subscription`)
      .set(...auth(h.tokens.admin))
      .send({ planId: testPlan.id, billingInterval: "day" });
    expect(assigned.status).toBe(200);
    expect(assigned.body.subscription.amountCents).toBe(100);

    // renewal date = today -> inside the 60-min window
    await h.db.withContext(sys, (q) =>
      q.query("UPDATE tenant_subscriptions SET renewal_date = current_date, current_period_end = current_date WHERE tenant_id=$1", [h.ids.tenants.acme]),
    );

    const tick = await h.api.post("/api/admin/billing/tick").set(...auth(h.tokens.admin));
    expect(tick.body.renewalsGenerated).toBe(1);

    const detail = await h.api.get(`/api/admin/billing/tenants/${h.ids.tenants.acme}`).set(...auth(h.tokens.admin));
    expect(detail.body.invoices).toHaveLength(1);
    const inv = detail.body.invoices[0];

    const rec = await h.api
      .post(`/api/admin/billing/invoices/${inv.id}/record-payment`)
      .set(...auth(h.tokens.admin))
      .send({ amountCents: 100, currency: "EUR" });
    expect(rec.body.outcome).toBe("applied");

    const after = await h.api.get(`/api/admin/billing/tenants/${h.ids.tenants.acme}`).set(...auth(h.tokens.admin));
    expect(after.body.invoices[0].status).toBe("paid");
  });
});
