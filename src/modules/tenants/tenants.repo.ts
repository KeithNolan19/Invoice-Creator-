import type { Queryable } from "../../db/types.ts";

export type TenantStatus = "active" | "suspended";

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  suspension_reason: "unpaid" | "other" | null;
  suspended_at: string | null;
  reactivated_at: string | null;
  reactivation_note: string | null;
  created_at: string;
  // Present on the admin list (subscription join); undefined elsewhere.
  plan_name?: string | null;
  plan_code?: string | null;
  billing_interval?: string | null;
  renewal_date?: string | null;
  subscription_status?: string | null;
}

const COLUMNS =
  "id, name, slug, status, suspension_reason, suspended_at, reactivated_at, reactivation_note, created_at";

/** Adds the subscription join — for the admin tenant list. */
const COLUMNS_WITH_SUB = `
  t.id, t.name, t.slug, t.status, t.suspension_reason, t.suspended_at,
  t.reactivated_at, t.reactivation_note, t.created_at,
  p.name AS plan_name, p.code AS plan_code, s.billing_interval,
  s.renewal_date, s.status AS subscription_status`;

export async function listTenants(q: Queryable): Promise<TenantRow[]> {
  const { rows } = await q.query<TenantRow>(
    `SELECT ${COLUMNS} FROM tenants ORDER BY name ASC`,
  );
  return rows;
}

export interface TenantListFilter {
  search?: string;
  status?: TenantStatus;
}

/** Admin tenant list with optional case-insensitive name/slug search + status filter. */
export async function listTenantsFiltered(
  q: Queryable,
  filter: TenantListFilter = {},
): Promise<TenantRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.search) {
    params.push(`%${filter.search.trim()}%`);
    where.push(`(t.name ILIKE $${params.length} OR t.slug ILIKE $${params.length})`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`t.status = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await q.query<TenantRow>(
    `SELECT ${COLUMNS_WITH_SUB}
       FROM tenants t
       LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
       LEFT JOIN subscription_plans p ON p.id = s.plan_id
       ${clause}
      ORDER BY t.name ASC`,
    params,
  );
  return rows;
}

export async function getTenantById(q: Queryable, id: string): Promise<TenantRow | null> {
  const { rows } = await q.query<TenantRow>(
    `SELECT ${COLUMNS} FROM tenants WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createTenant(
  q: Queryable,
  input: { name: string; slug: string },
): Promise<TenantRow> {
  const { rows } = await q.query<TenantRow>(
    `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING ${COLUMNS}`,
    [input.name.trim(), input.slug.trim().toLowerCase()],
  );
  return rows[0]!;
}

/** Sets status only when it actually changes; returns null if the row was a no-op or not found. */
export async function setTenantStatus(
  q: Queryable,
  id: string,
  status: TenantStatus,
): Promise<TenantRow | null> {
  const { rows } = await q.query<TenantRow>(
    `UPDATE tenants SET status = $2 WHERE id = $1 AND status <> $2 RETURNING ${COLUMNS}`,
    [id, status],
  );
  return rows[0] ?? null;
}

export interface TenantUsage {
  user_count: number;
  active_user_count: number;
  invoice_count: number;
  last_invoice_at: string | null;
  last_admin_action_at: string | null;
}

export async function getTenantUsage(q: Queryable, id: string): Promise<TenantUsage> {
  const { rows } = await q.query<TenantUsage>(
    `SELECT
        (SELECT count(*) FROM users u WHERE u.tenant_id = $1)::int AS user_count,
        (SELECT count(*) FROM users u WHERE u.tenant_id = $1 AND u.disabled_at IS NULL)::int AS active_user_count,
        (SELECT count(*) FROM invoices i WHERE i.tenant_id = $1)::int AS invoice_count,
        (SELECT max(i.created_at) FROM invoices i WHERE i.tenant_id = $1) AS last_invoice_at,
        (SELECT max(a.created_at) FROM audit_logs a WHERE a.tenant_id = $1) AS last_admin_action_at`,
    [id],
  );
  return rows[0]!;
}

export function serializeTenant(row: TenantRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    suspensionReason: row.suspension_reason,
    suspendedAt: row.suspended_at,
    reactivatedAt: row.reactivated_at,
    reactivationNote: row.reactivation_note,
    createdAt: row.created_at,
    ...(row.plan_code !== undefined
      ? {
          subscription: row.plan_code
            ? {
                planCode: row.plan_code,
                planName: row.plan_name,
                billingInterval: row.billing_interval,
                renewalDate: row.renewal_date,
                status: row.subscription_status,
              }
            : null,
        }
      : {}),
  };
}
