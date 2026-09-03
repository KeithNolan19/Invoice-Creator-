/**
 * A minimal database seam so the same application and SQL run against either
 * node-postgres (production) or PGlite (tests), with identical RLS semantics.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<T>>;

  /** Run one or more statements with no parameters (used by the migrator). */
  exec(sql: string): Promise<void>;
}

/** The tenant/authorization context enforced by Postgres Row-Level Security. */
export interface RlsContext {
  userId: string;
  /** null for platform admins, who are not bound to a single tenant. */
  tenantId: string | null;
  isAdmin: boolean;
}

export interface Db {
  /**
   * Run `fn` inside a transaction that has switched to the unprivileged
   * `invoice_app` role and set the `app.current_tenant` / `app.is_admin`
   * GUCs. Every tenant-owned table is filtered by RLS for the duration.
   */
  withContext<T>(ctx: RlsContext, fn: (q: Queryable) => Promise<T>): Promise<T>;

  /**
   * Run `fn` as the `invoice_auth` role: RLS is bypassed, but the role can only
   * SELECT `users` and `tenants`. This is the ONLY escape hatch used at request
   * time, and only for the pre-authentication identity lookup (no tenant context
   * exists yet).
   */
  bypassRls<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;

  /**
   * Run `fn` with the connection's own privileges. Used by migrations, seeding
   * and the test harness — the production app process never calls this.
   */
  privileged<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}
