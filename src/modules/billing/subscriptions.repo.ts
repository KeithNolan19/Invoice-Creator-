import type { Queryable } from "../../db/types.ts";
import { type BillingInterval, periodEnd, resolveAmountCents } from "../../billing/pricing.ts";
import { getPlan } from "./plans.repo.ts";
import { getBillingConfigSafe } from "./billing-config.repo.ts";

export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  plan_code: string;
  plan_name: string;
  plan_max_users: number;
  billing_interval: BillingInterval;
  amount_cents: string;
  currency: string;
  status: "active" | "cancelled";
  current_period_start: string;
  current_period_end: string;
  renewal_date: string;
  cancel_at_period_end: boolean;
  created_at: string;
}

const SELECT = `
  SELECT s.id, s.tenant_id, s.plan_id, p.code AS plan_code, p.name AS plan_name,
         p.max_users AS plan_max_users, s.billing_interval, s.amount_cents, s.currency,
         s.status, s.current_period_start, s.current_period_end, s.renewal_date,
         s.cancel_at_period_end, s.created_at
    FROM tenant_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
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
  const cfg = await getBillingConfigSafe(q);

  const existing = await getSubscriptionForTenant(q, input.tenantId);
  const start = input.periodStart ?? (existing ? new Date(existing.current_period_start) : new Date());
  const startDate = toDateOnly(start);
  const end = periodEnd(startDate, input.billingInterval);
  const renewal = new Date(end);
  renewal.setUTCDate(renewal.getUTCDate() + 1);

  const amount = resolveAmountCents(Number(plan.monthly_cents), input.billingInterval, Number(cfg.yearlyDiscountPct ?? 5));

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
    plan: { id: s.plan_id, code: s.plan_code, name: s.plan_name, maxUsers: s.plan_max_users },
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
