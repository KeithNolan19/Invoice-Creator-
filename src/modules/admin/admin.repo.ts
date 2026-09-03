import type { Queryable } from "../../db/types.ts";

export interface DashboardStats {
  total_tenants: number;
  active_tenants: number;
  suspended_tenants: number;
  total_users: number;
  active_users: number;
  disabled_users: number;
  online_users: number;
  total_invoices: number;
  admin_actions: number;
  admin_actions_7d: number;
}

/** All counts run in an admin RLS context, so they span every tenant. */
export async function getDashboardStats(q: Queryable): Promise<DashboardStats> {
  const { rows } = await q.query<DashboardStats>(`
    SELECT
      (SELECT count(*) FROM tenants)::int                                   AS total_tenants,
      (SELECT count(*) FROM tenants WHERE status = 'active')::int           AS active_tenants,
      (SELECT count(*) FROM tenants WHERE status = 'suspended')::int        AS suspended_tenants,
      (SELECT count(*) FROM users)::int                                     AS total_users,
      (SELECT count(*) FROM users WHERE disabled_at IS NULL)::int           AS active_users,
      (SELECT count(*) FROM users WHERE disabled_at IS NOT NULL)::int       AS disabled_users,
      (SELECT count(*) FROM users
         WHERE last_seen_at > now() - interval '5 minutes'
           AND (tokens_invalid_before IS NULL OR last_seen_at > tokens_invalid_before))::int AS online_users,
      (SELECT count(*) FROM invoices)::int                                  AS total_invoices,
      (SELECT count(*) FROM audit_logs)::int                                AS admin_actions,
      (SELECT count(*) FROM audit_logs WHERE created_at > now() - interval '7 days')::int AS admin_actions_7d
  `);
  return rows[0]!;
}

export function serializeDashboard(s: DashboardStats) {
  return {
    tenants: { total: s.total_tenants, active: s.active_tenants, suspended: s.suspended_tenants },
    users: {
      total: s.total_users,
      active: s.active_users,
      disabled: s.disabled_users,
      online: s.online_users,
    },
    activity: {
      totalInvoices: s.total_invoices,
      adminActions: s.admin_actions,
      adminActionsLast7Days: s.admin_actions_7d,
    },
  };
}

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .toLowerCase()
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");
}
