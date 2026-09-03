import type { Queryable } from "../../db/types.ts";
import {
  type BillingInterval,
  intervalAllowedForPlan,
  nextPeriodStart,
  periodEnd,
  resolveAmountCents,
} from "../../billing/pricing.ts";
import { getPlan } from "./plans.repo.ts";
import { getBillingConfigSafe } from "./billing-config.repo.ts";

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  plan_max_users: number;
  plan_base_interval: "day" | "month";
  plan_reminder_lead_minutes: number;
  plan_is_test: boolean;
  billing_interval: BillingInterval;
  amount_cents: string;
  currency: string;
  status: "active" | "cancelled";
  current_period_start: string;
  current_period_end: string;
  renewal_date: string;
  last_renewal_generated_for: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
}

const SELECT = `
  SELECT s.id, s.tenant_id, t.name AS tenant_name, s.plan_id, p.code AS plan_code, p.name AS plan_name,
         p.max_users AS plan_max_users, p.base_interval AS plan_base_interval,
         p.reminder_lead_minutes AS plan_reminder_lead_minutes, p.is_test AS plan_is_test,
         s.billing_interval, s.amount_cents, s.currency,
         s.status, s.current_period_start, s.current_period_end, s.renewal_date,
         s.last_renewal_generated_for, s.cancel_at_period_end, s.created_at
    FROM tenant_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    JOIN tenants t ON t.id = s.tenant_id
`;

export async function getSubscriptionForTenant(q: Queryable, tenantId: string): Promise<SubscriptionRow | null> {
  const { rows } = await q.query<SubscriptionRow>(`${SELECT} WHERE s.tenant_id = $1`, [tenantId]);
  return rows[0] ?? null;
}

export interface SetSubscriptionInput {
  tenantId: string;
  planId: string;
  billingInterval: BillingInterval;
  /** Period start. Defaults to today for a new subscription; kept for an existing one unless given. */
  periodStart?: Date;
  createdBy: string;
}

/**
 * Creates or replaces a tenant's subscription. Resolves the amount from the
 * plan's monthly price + interval + the platform yearly discount, and computes
 * the period window. Admin context only (RLS: `..._write` is `app_is_admin()`).
 */
export async function setSubscription(q: Queryable, input: SetSubscriptionInput): Promise<SubscriptionRow> {
  const plan = await getPlan(q, input.planId);
  if (!plan) throw new Error("plan not found");
  if (!intervalAllowedForPlan(plan.base_interval, input.billingInterval)) {
    throw new Error(`"${input.billingInterval}" billing is not available for the ${plan.name} plan`);
  }
  const cfg = await getBillingConfigSafe(q);

  const existing = await getSubscriptionForTenant(q, input.tenantId);
  const start = input.periodStart ?? (existing ? new Date(existing.current_period_start) : new Date());
  const startDate = toDateOnly(start);
  const end = periodEnd(startDate, input.billingInterval);
  const renewal = nextPeriodStart(startDate, input.billingInterval);

  const amount = resolveAmountCents(
    Number(plan.base_amount_cents),
    plan.base_interval,
    input.billingInterval,
    Number(cfg.yearlyDiscountPct ?? 5),
  );

  await q.query(
    `INSERT INTO tenant_subscriptions
       (tenant_id, plan_id, billing_interval, amount_cents, currency, status,
        current_period_start, current_period_end, renewal_date, created_by)
     VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       billing_interval = EXCLUDED.billing_interval,
       amount_cents = EXCLUDED.amount_cents,
       currency = EXCLUDED.currency,
       status = 'active',
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       renewal_date = EXCLUDED.renewal_date,
       cancel_at_period_end = false,
       updated_at = now()`,
    [
      input.tenantId,
      input.planId,
      input.billingInterval,
      amount,
      plan.currency,
      iso(startDate),
      iso(end),
      iso(renewal),
      input.createdBy,
    ],
  );
  return (await getSubscriptionForTenant(q, input.tenantId))!;
}

/** Active subscriptions, for the scheduler. Admin/system context. */
export async function listActiveSubscriptions(q: Queryable): Promise<SubscriptionRow[]> {
  const { rows } = await q.query<SubscriptionRow>(`${SELECT} WHERE s.status = 'active' ORDER BY s.renewal_date`);
  return rows;
}

/** Records that the renewal for `periodStart` has been generated (idempotency marker). */
export async function markRenewalGenerated(q: Queryable, subscriptionId: string, periodStart: string): Promise<void> {
  await q.query(
    `UPDATE tenant_subscriptions SET last_renewal_generated_for = $2, updated_at = now() WHERE id = $1`,
    [subscriptionId, periodStart],
  );
}

/** Rolls the period window forward one interval (called once the renewal invoice is paid). */
export async function advanceSubscriptionPeriod(
  q: Queryable,
  subscriptionId: string,
  next: { periodStart: string; periodEnd: string; renewalDate: string },
): Promise<void> {
  await q.query(
    `UPDATE tenant_subscriptions
        SET current_period_start = $2, current_period_end = $3, renewal_date = $4, updated_at = now()
      WHERE id = $1`,
    [subscriptionId, next.periodStart, next.periodEnd, next.renewalDate],
  );
}

export async function cancelSubscription(q: Queryable, tenantId: string, atPeriodEnd: boolean): Promise<void> {
  await q.query(
    atPeriodEnd
      ? `UPDATE tenant_subscriptions SET cancel_at_period_end = true, updated_at = now() WHERE tenant_id = $1`
      : `UPDATE tenant_subscriptions SET status = 'cancelled', updated_at = now() WHERE tenant_id = $1`,
    [tenantId],
  );
}

export function serializeSubscription(s: SubscriptionRow) {
  return {
    id: s.id,
    tenantId: s.tenant_id,
    tenantName: s.tenant_name,
    plan: {
      id: s.plan_id,
      code: s.plan_code,
      name: s.plan_name,
      maxUsers: s.plan_max_users,
      baseInterval: s.plan_base_interval,
      isTest: s.plan_is_test,
    },
    billingInterval: s.billing_interval,
    amountCents: Number(s.amount_cents),
    currency: s.currency,
    status: s.status,
    currentPeriodStart: s.current_period_start,
    currentPeriodEnd: s.current_period_end,
    renewalDate: s.renewal_date,
    cancelAtPeriodEnd: s.cancel_at_period_end,
  };
}

function toDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
