import type { Queryable } from "../../db/types.ts";

export interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  role: "user" | "admin";
  tenant_id: string | null;
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
  disabled_at: string | null;
  created_at: string;
}

// The pre-auth / per-request identity lookup needs the tenant's status too, so a
// suspended tenant or disabled account can be rejected before any handler runs.
const AUTH_SELECT = `
  SELECT u.id, u.email, u.password_hash, u.name, u.role, u.tenant_id,
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

const USER_COLUMNS = "id, email, name, role, tenant_id, disabled_at, created_at";

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
 * tenant by accident.
 */
export async function createTenantUser(
  q: Queryable,
  input: { email: string; name: string; passwordHash: string; tenantId: string },
): Promise<TenantUserRow> {
  const { rows } = await q.query<TenantUserRow>(
    `INSERT INTO users (email, password_hash, name, role, tenant_id)
     VALUES ($1, $2, $3, 'user', $4)
     RETURNING ${USER_COLUMNS}`,
    [input.email.trim().toLowerCase(), input.passwordHash, input.name.trim(), input.tenantId],
  );
  return rows[0]!;
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
    disabled: row.disabled_at !== null,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
  };
}
