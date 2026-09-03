import type { Queryable } from "../../db/types.ts";
import type { PlanInterval } from "../../billing/pricing.ts";

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  max_users: number;
  base_interval: PlanInterval;
  base_amount_cents: string;
  currency: string;
  sort_order: number;
  active: boolean;
  reminder_lead_minutes: number;
  is_test: boolean;
}

const COLUMNS =
  "id, code, name, max_users, base_interval, base_amount_cents, currency, sort_order, active, reminder_lead_minutes, is_test";

export async function listPlans(q: Queryable, opts: { includeInactive?: boolean } = {}): Promise<PlanRow[]> {
  const where = opts.includeInactive ? "" : "WHERE active";
  const { rows } = await q.query<PlanRow>(
    `SELECT ${COLUMNS} FROM subscription_plans ${where} ORDER BY sort_order, base_amount_cents`,
  );
  return rows;
}

export async function getPlan(q: Queryable, id: string): Promise<PlanRow | null> {
  const { rows } = await q.query<PlanRow>(`SELECT ${COLUMNS} FROM subscription_plans WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getPlanByCode(q: Queryable, code: string): Promise<PlanRow | null> {
  const { rows } = await q.query<PlanRow>(`SELECT ${COLUMNS} FROM subscription_plans WHERE code = $1`, [code]);
  return rows[0] ?? null;
}

export function serializePlan(p: PlanRow) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    maxUsers: p.max_users,
    baseInterval: p.base_interval,
    baseAmountCents: Number(p.base_amount_cents),
    currency: p.currency,
    active: p.active,
    reminderLeadMinutes: p.reminder_lead_minutes,
    isTest: p.is_test,
  };
}
