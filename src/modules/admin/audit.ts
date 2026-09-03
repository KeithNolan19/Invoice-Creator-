import type { Queryable } from "../../db/types.ts";

export type AuditAction =
  | "tenant.created"
  | "tenant.suspended"
  | "tenant.reactivated"
  | "user.created"
  | "user.disabled"
  | "user.enabled";

export interface AuditEntry {
  actorUserId: string;
  action: AuditAction;
  tenantId?: string | null;
  targetUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit record. Call inside the same `withContext` transaction as the
 * action it describes so the two commit or roll back together.
 */
export async function recordAudit(q: Queryable, entry: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (actor_user_id, action, tenant_id, target_user_id, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      entry.actorUserId,
      entry.action,
      entry.tenantId ?? null,
      entry.targetUserId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

export interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  tenant_id: string | null;
  tenant_name: string | null;
  target_user_id: string | null;
  target_email: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function listAuditLogs(
  q: Queryable,
  opts: { tenantId?: string; limit?: number } = {},
): Promise<AuditLogRow[]> {
  const params: unknown[] = [];
  let where = "";
  if (opts.tenantId) {
    params.push(opts.tenantId);
    where = `WHERE a.tenant_id = $${params.length}`;
  }
  params.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  const { rows } = await q.query<AuditLogRow>(
    `SELECT a.id, a.actor_user_id, actor.email AS actor_email, a.action,
            a.tenant_id, t.name AS tenant_name,
            a.target_user_id, target.email AS target_email,
            a.metadata, a.created_at
       FROM audit_logs a
       LEFT JOIN users actor  ON actor.id  = a.actor_user_id
       LEFT JOIN users target ON target.id = a.target_user_id
       LEFT JOIN tenants t    ON t.id      = a.tenant_id
       ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

export function serializeAuditLog(row: AuditLogRow) {
  return {
    id: row.id,
    action: row.action,
    actor: row.actor_user_id ? { id: row.actor_user_id, email: row.actor_email } : null,
    tenant: row.tenant_id ? { id: row.tenant_id, name: row.tenant_name } : null,
    targetUser: row.target_user_id ? { id: row.target_user_id, email: row.target_email } : null,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}
