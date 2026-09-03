import type { Queryable } from "../../db/types.ts";

export type TenantRole = "admin" | "member";

export interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: "user" | "admin";
  tenant_id: string | null;
  tenant_role: TenantRole | null;
  disabled_at: string | Date | null;
  tokens_invalid_before: string | Date | null;
  tenant_status: "active" | "suspended" | null;
}

export interface TenantUserRow {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  tenant_id: string | null;
  tenant_role: TenantRole | null;
  disabled_at: string | null;
  created_at: string;
  last_seen_at: string | null;
  last_login_at: string | null;
}

// The pre-auth / per-request identity lookup needs the tenant's status too, so a
// suspended tenant or disabled account can be rejected before any handler runs.
const AUTH_SELECT = `
  SELECT u.id, u.email, u.password_hash, u.name, u.role, u.tenant_id, u.tenant_role,
         u.disabled_at, u.tokens_invalid_before, t.status AS tenant_status
    FROM users u
    LEFT JOIN tenants t ON t.id = u.tenant_id
`;

export async function findAuthUserByEmail(q: Queryable, email: string): Promise<AuthUserRow | null> {
  const { rows } = await q.query<AuthUserRow>(`${AUTH_SELECT} WHERE u.email = $1`, [
    email.trim().toLowerCase(),
  ]);
  return rows[0] ?? null;
}

export async function findAuthUserById(q: Queryable, id: string): Promise<AuthUserRow | null> {
  const { rows } = await q.query<AuthUserRow>(`${AUTH_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] ?? null;
}

const USER_COLUMNS =
  "id, email, name, role, tenant_id, tenant_role, disabled_at, created_at, last_seen_at, last_login_at";

/**
 * Visible users, subject to whatever RLS context the caller is running in. An
 * optional tenant filter is only additive — it can never widen what RLS allows.
 */
export async function listUsers(
  q: Queryable,
  opts: { tenantId?: string | null } = {},
): Promise<TenantUserRow[]> {
  if (opts.tenantId) {
    const { rows } = await q.query<TenantUserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [opts.tenantId],
    );
    return rows;
  }
  const { rows } = await q.query<TenantUserRow>(
    `SELECT ${USER_COLUMNS} FROM users ORDER BY created_at ASC`,
  );
  return rows;
}

export async function getUserById(q: Queryable, id: string): Promise<TenantUserRow | null> {
  const { rows } = await q.query<TenantUserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Creates a tenant user. `role` is always 'user' and `tenant_id` is taken from
 * the caller-supplied argument (which admin routes derive from the URL, never
 * the request body) so an admin action can never place a user in the wrong
 * tenant by accident. `tenantRole` is likewise decided server-side by the
 * caller (first user of a tenant -> admin, otherwise member).
 */
export async function createTenantUser(
  q: Queryable,
  input: {
    email: string;
    name: string;
    passwordHash: string;
    tenantId: string;
    tenantRole: TenantRole;
  },
): Promise<TenantUserRow> {
  const { rows } = await q.query<TenantUserRow>(
    `INSERT INTO users (email, password_hash, name, role, tenant_id, tenant_role)
     VALUES ($1, $2, $3, 'user', $4, $5)
     RETURNING ${USER_COLUMNS}`,
    [
      input.email.trim().toLowerCase(),
      input.passwordHash,
      input.name.trim(),
      input.tenantId,
      input.tenantRole,
    ],
  );
  return rows[0]!;
}

/** Count users in a tenant (RLS-scoped). Used to decide the first user's role. */
export async function countTenantUsers(q: Queryable, tenantId: string): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM users WHERE tenant_id = $1",
    [tenantId],
  );
  return rows[0]!.n;
}

/**
 * Sets a tenant user's role within the caller's tenant. Delegates to the
 * SECURITY DEFINER `set_tenant_member_role` function, which re-checks that the
 * caller is a tenant admin of the target's tenant and only ever changes
 * `tenant_role`. Returns null when nothing matched (wrong tenant, platform
 * admin, or no such user).
 */
export async function setTenantRole(
  q: Queryable,
  id: string,
  tenantRole: TenantRole,
): Promise<TenantUserRow | null> {
  const { rows } = await q.query<{ tenant_id: string | null }>(
    "SELECT set_tenant_member_role($1, $2) AS tenant_id",
    [id, tenantRole],
  );
  if (!rows[0]?.tenant_id) return null;
  return getUserById(q, id);
}

/**
 * Disables a user and revokes every token they already hold. Only touches
 * `disabled_at` / `tokens_invalid_before` — never role or tenant_id.
 */
export async function disableUser(q: Queryable, id: string): Promise<TenantUserRow | null> {
  const { rows } = await q.query<TenantUserRow>(
    `UPDATE users SET disabled_at = now(), tokens_invalid_before = now()
     WHERE id = $1 AND disabled_at IS NULL
     RETURNING ${USER_COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Re-enables a disabled user. Clears `disabled_at` only; tenant and role are
 * untouched, and `tokens_invalid_before` stays put so the previously issued
 * tokens remain dead — the user signs in again.
 */
export async function enableUser(q: Queryable, id: string): Promise<TenantUserRow | null> {
  const { rows } = await q.query<TenantUserRow>(
    `UPDATE users SET disabled_at = NULL
     WHERE id = $1 AND disabled_at IS NOT NULL
     RETURNING ${USER_COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}

export function serializeUser(row: TenantUserRow) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    tenantId: row.tenant_id,
    tenantRole: row.tenant_role,
    disabled: row.disabled_at !== null,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    lastLoginAt: row.last_login_at,
    online: isOnline(row.last_seen_at),
  };
}

/** "Online" = an authenticated request in the last 5 minutes (tokens last 30). */
export const ONLINE_WINDOW_MS = 5 * 60_000;
export function isOnline(lastSeenAt: string | Date | null): boolean {
  if (!lastSeenAt) return false;
  const t = lastSeenAt instanceof Date ? lastSeenAt.getTime() : Date.parse(lastSeenAt);
  return Number.isFinite(t) && Date.now() - t < ONLINE_WINDOW_MS;
}
