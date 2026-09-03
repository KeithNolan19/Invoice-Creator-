import type { Queryable } from "../../db/types.ts";

interface RawStats {
  outstanding_count: number;
  outstanding_cents: string;
  pending_count: number;
  pending_cents: string;
  overdue_count: number;
  overdue_cents: string;
  paid_30d_count: number;
  paid_30d_cents: string;
  draft_count: number;
  total_invoices: number;
  customer_count: number;
}

const OUTSTANDING = "payment_status IN ('unpaid','pending') AND status NOT IN ('draft','void')";

/** Tenant-scoped by RLS; `tenantId` narrows the aggregate to one tenant's rows. */
export async function getDashboard(q: Queryable, tenantId: string): Promise<RawStats> {
  const { rows } = await q.query<RawStats>(
    `SELECT
       (SELECT count(*) FROM invoices WHERE tenant_id = $1 AND ${OUTSTANDING})::int AS outstanding_count,
       (SELECT coalesce(sum(total_cents),0) FROM invoices WHERE tenant_id = $1 AND ${OUTSTANDING}) AS outstanding_cents,
       (SELECT count(*) FROM invoices WHERE tenant_id = $1 AND payment_status = 'pending' AND status NOT IN ('draft','void'))::int AS pending_count,
       (SELECT coalesce(sum(total_cents),0) FROM invoices WHERE tenant_id = $1 AND payment_status = 'pending' AND status NOT IN ('draft','void')) AS pending_cents,
       (SELECT count(*) FROM invoices WHERE tenant_id = $1 AND ${OUTSTANDING} AND due_on IS NOT NULL AND due_on < current_date)::int AS overdue_count,
       (SELECT coalesce(sum(total_cents),0) FROM invoices WHERE tenant_id = $1 AND ${OUTSTANDING} AND due_on IS NOT NULL AND due_on < current_date) AS overdue_cents,
       (SELECT count(*) FROM invoices WHERE tenant_id = $1 AND payment_status = 'paid' AND paid_at IS NOT NULL AND paid_at > now() - interval '30 days')::int AS paid_30d_count,
       (SELECT coalesce(sum(coalesce(paid_amount_cents,total_cents)),0) FROM invoices WHERE tenant_id = $1 AND payment_status = 'paid' AND paid_at IS NOT NULL AND paid_at > now() - interval '30 days') AS paid_30d_cents,
       (SELECT count(*) FROM invoices WHERE tenant_id = $1 AND status = 'draft')::int AS draft_count,
       (SELECT count(*) FROM invoices WHERE tenant_id = $1)::int AS total_invoices,
       (SELECT count(*) FROM customers WHERE tenant_id = $1 AND archived_at IS NULL)::int AS customer_count`,
    [tenantId],
  );
  return rows[0]!;
}

export function serializeDashboard(s: RawStats) {
  return {
    outstanding: { count: s.outstanding_count, totalCents: Number(s.outstanding_cents) },
    pending: { count: s.pending_count, totalCents: Number(s.pending_cents) },
    overdue: { count: s.overdue_count, totalCents: Number(s.overdue_cents) },
    paidLast30Days: { count: s.paid_30d_count, totalCents: Number(s.paid_30d_cents) },
    drafts: { count: s.draft_count },
    totals: { invoices: s.total_invoices, customers: s.customer_count },
  };
}
