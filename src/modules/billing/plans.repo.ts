import type { Queryable } from "../../db/types.ts";

export interface PlanRow {
  id: string;
  code: string;
  name: string;
  max_users: number;
  monthly_cents: string;
  currency: string;
  sort_order: number;
  active: boolean;
}

const COLUMNS = "id, code, name, max_users, monthly_cents, currency, sort_order, active";

export async function listPlans(q: Queryable, opts: { includeInactive?: boolean } = {}): Promise<PlanRow[]> {
  const where = opts.includeInactive ? "" : "WHERE active";
  const { rows } = await q.query<PlanRow>(
    `SELECT ${COLUMNS} FROM subscription_plans ${where} ORDER BY sort_order, monthly_cents`,
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
    monthlyCents: Number(p.monthly_cents),
    currency: p.currency,
    active: p.active,
  };
}
