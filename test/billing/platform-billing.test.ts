import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listPlans } from "../../src/modules/billing/plans.repo.ts";
import { getSubscriptionForTenant, setSubscription } from "../../src/modules/billing/subscriptions.repo.ts";
import {
  allocatePlatformInvoiceNumber,
  insertPlatformInvoice,
  listPlatformInvoices,
  setPlatformInvoiceStatus,
} from "../../src/modules/billing/platform-invoices.repo.ts";
import {
  createNotification,
  listNotifications,
  markAllNotificationsRead,
} from "../../src/modules/billing/notifications.repo.ts";
import { SYSTEM_CONTEXT } from "../../src/db/system-context.ts";
import type { RlsContext } from "../../src/db/types.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const adminCtx: RlsContext = SYSTEM_CONTEXT;
const acmeCtx = (): RlsContext => ({
  userId: h.ids.users.alice,
  tenantId: h.ids.tenants.acme,
  isAdmin: false,
  tenantRole: "admin",
});
const smithCtx = (): RlsContext => ({
  userId: h.ids.users.bob,
  tenantId: h.ids.tenants.smith,
  isAdmin: false,
  tenantRole: "admin",
});

describe("subscription plans", () => {
  it("migration 011 seeds the three tiers", async () => {
    const plans = await h.db.withContext(acmeCtx(), (q) => listPlans(q));
    expect(plans.map((p) => p.code)).toEqual(["starter", "team", "business"]);
    expect(plans.map((p) => Number(p.monthly_cents))).toEqual([1000, 1500, 2000]);
  });

  it("a tenant cannot create or edit plans", async () => {
    await expect(
      h.db.withContext(acmeCtx(), (q) =>
        q.query("INSERT INTO subscription_plans (code,name,max_users,monthly_cents) VALUES ('x','X',1,1)"),
      ),
    ).rejects.toThrow();
  });
});

describe("subscriptions — pricing + isolation", () => {
  it("resolves the yearly amount from the plan + platform discount", async () => {
    const plans = await h.db.withContext(adminCtx, (q) => listPlans(q));
    const team = plans.find((p) => p.code === "team")!;

    const monthly = await h.db.withContext(adminCtx, (q) =>
      setSubscription(q, {
        tenantId: h.ids.tenants.acme,
        planId: team.id,
        billingInterval: "month",
        createdBy: h.ids.users.admin,
      }),
    );
    expect(Number(monthly.amount_cents)).toBe(1500);

    const yearly = await h.db.withContext(adminCtx, (q) =>
      setSubscription(q, {
        tenantId: h.ids.tenants.acme,
        planId: team.id,
        billingInterval: "year",
        createdBy: h.ids.users.admin,
      }),
    );
    expect(Number(yearly.amount_cents)).toBe(17100); // 15000*12 - 5%
  });

  it("a tenant reads only its own subscription; never writes one", async () => {
    const plans = await h.db.withContext(adminCtx, (q) => listPlans(q));
    await h.db.withContext(adminCtx, (q) =>
      setSubscription(q, {
        tenantId: h.ids.tenants.acme,
        planId: plans[0]!.id,
        billingInterval: "month",
        createdBy: h.ids.users.admin,
      }),
    );

    expect(await h.db.withContext(acmeCtx(), (q) => getSubscriptionForTenant(q, h.ids.tenants.acme))).not.toBeNull();
    // Smith sees nothing of Acme's
    expect(await h.db.withContext(smithCtx(), (q) => getSubscriptionForTenant(q, h.ids.tenants.acme))).toBeNull();
    // and cannot write its own
    await expect(
      h.db.withContext(smithCtx(), (q) =>
        q.query(
          `INSERT INTO tenant_subscriptions
             (tenant_id, plan_id, billing_interval, amount_cents, current_period_start, current_period_end, renewal_date)
           VALUES ($1, $2, 'month', 1, current_date, current_date, current_date)`,
          [h.ids.tenants.smith, plans[0]!.id],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("platform invoices — numbering, idempotency, isolation, state", () => {
  const mkInvoice = (tenantId: string, over: Partial<Parameters<typeof insertPlatformInvoice>[1]> = {}) =>
    h.db.withContext(adminCtx, async (q) => {
      const number = await allocatePlatformInvoiceNumber(q);
      return insertPlatformInvoice(q, {
        tenantId,
        number,
        subscriptionId: null,
        kind: "adhoc",
        dueDate: "2026-12-31",
        description: "Test",
        currency: "EUR",
        amountCents: 1500,
        ...over,
      });
    });

  it("allocates sequential VD- numbers", async () => {
    const a = await mkInvoice(h.ids.tenants.acme);
    const b = await mkInvoice(h.ids.tenants.acme);
    expect(a!.number).toMatch(/^VD-\d{6}$/);
    expect(Number(b!.number.slice(3))).toBe(Number(a!.number.slice(3)) + 1);
  });

  it("the renewal period unique index makes a re-run a no-op", async () => {
    const plans = await h.db.withContext(adminCtx, (q) => listPlans(q));
    const sub = await h.db.withContext(adminCtx, (q) =>
      setSubscription(q, {
        tenantId: h.ids.tenants.acme,
        planId: plans[0]!.id,
        billingInterval: "month",
        createdBy: h.ids.users.admin,
      }),
    );
    const first = await h.db.withContext(adminCtx, async (q) =>
      insertPlatformInvoice(q, {
        tenantId: h.ids.tenants.acme,
        number: await allocatePlatformInvoiceNumber(q),
        subscriptionId: sub.id,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        dueDate: "2026-07-14",
        description: "July",
        currency: "EUR",
        amountCents: 1000,
      }),
    );
    expect(first).not.toBeNull();
    const dup = await h.db.withContext(adminCtx, async (q) =>
      insertPlatformInvoice(q, {
        tenantId: h.ids.tenants.acme,
        number: await allocatePlatformInvoiceNumber(q),
        subscriptionId: sub.id,
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        dueDate: "2026-07-14",
        description: "July again",
        currency: "EUR",
        amountCents: 1000,
      }),
    );
    expect(dup).toBeNull(); // ON CONFLICT DO NOTHING
    const list = await h.db.withContext(adminCtx, (q) => listPlatformInvoices(q, { tenantId: h.ids.tenants.acme }));
    expect(list).toHaveLength(1);
  });

  it("Tenant A never sees Tenant B's invoices, and cannot write any", async () => {
    await mkInvoice(h.ids.tenants.acme);

    const smithView = await h.db.withContext(smithCtx(), (q) => listPlatformInvoices(q));
    expect(smithView).toHaveLength(0);

    await expect(
      h.db.withContext(smithCtx(), (q) =>
        q.query(
          `INSERT INTO platform_invoices (tenant_id, number, due_date, description, currency, amount_cents)
           VALUES ($1, 'HACK-1', '2026-12-31', 'x', 'EUR', 1)`,
          [h.ids.tenants.acme],
        ),
      ),
    ).rejects.toThrow();

    // admin sees it
    const adminView = await h.db.withContext(adminCtx, (q) => listPlatformInvoices(q));
    expect(adminView).toHaveLength(1);
  });

  it("enforces the state machine on status changes", async () => {
    const inv = await mkInvoice(h.ids.tenants.acme);
    await expect(
      h.db.withContext(adminCtx, (q) => setPlatformInvoiceStatus(q, inv!.id, "paid")),
    ).rejects.toThrow(/cannot move from draft to paid/);

    const issued = await h.db.withContext(adminCtx, (q) => setPlatformInvoiceStatus(q, inv!.id, "issued"));
    expect(issued!.status).toBe("issued");
    const pending = await h.db.withContext(adminCtx, (q) =>
      setPlatformInvoiceStatus(q, inv!.id, "payment_pending", { paymentProvider: "fire", paymentReference: "ref-1" }),
    );
    expect(pending!.status).toBe("payment_pending");
    expect(pending!.payment_reference).toBe("ref-1");
  });
});

describe("admin notifications", () => {
  it("are platform-admin only and dedupe by key", async () => {
    await h.db.withContext(adminCtx, (q) =>
      createNotification(q, { type: "payment_overdue", tenantId: h.ids.tenants.acme, title: "Overdue", dedupeKey: "overdue:x" }),
    );
    await h.db.withContext(adminCtx, (q) =>
      createNotification(q, { type: "payment_overdue", tenantId: h.ids.tenants.acme, title: "Overdue again", dedupeKey: "overdue:x" }),
    );
    const list = await h.db.withContext(adminCtx, (q) => listNotifications(q));
    expect(list).toHaveLength(1);

    // a tenant cannot read the notification centre
    await expect(
      h.db.withContext(acmeCtx(), (q) => q.query("SELECT * FROM admin_notifications")),
    ).resolves.toMatchObject({ rows: [] });

    const cleared = await h.db.withContext(adminCtx, (q) => markAllNotificationsRead(q));
    expect(cleared).toBe(1);
  });
});
