import type { Db, Queryable, RlsContext } from "./types.ts";

/**
 * RLS context for trusted server-side work with no logged-in user: the webhook
 * receiver and the scheduled billing jobs.
 *
 * It is an *admin-scoped* context (cross-tenant, like the platform admin), but
 * with no user id — audit rows written from here have `actor_user_id = NULL` and
 * should carry `metadata.source = 'webhook' | 'scheduler'`.
 *
 * RLS stays fully enforced; this is not `db.privileged()` (which bypasses RLS
 * and is reserved for migrations/seed/tests).
 */
export const SYSTEM_CONTEXT: RlsContext = {
  userId: "",
  tenantId: null,
  isAdmin: true,
  tenantRole: null,
};

export function withSystemContext<T>(db: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
  return db.withContext(SYSTEM_CONTEXT, fn);
}
