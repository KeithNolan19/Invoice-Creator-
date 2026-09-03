# Invoice Creator — Backend

Database, authentication, tenant isolation, the Admin Control Centre, and a
production-hardening pass. No payments. The existing sign-in HTML (`index.html`,
`test-version-1.html`) is untouched. Deployment/backup detail lives in
[DEPLOYMENT.md](./DEPLOYMENT.md).

## Stack

| Concern    | Choice                                                    |
| ---------- | ------------------------------------------------------- |
| Runtime    | Node + TypeScript (run directly via `tsx`)              |
| HTTP       | Express 5                                               |
| Database   | PostgreSQL (`pg` in production, PGlite in tests)        |
| Auth       | JWT access tokens (`jsonwebtoken`) + bcrypt (`bcryptjs`) |
| Validation | `zod` (strict schemas on all writes)                    |
| Tests      | `vitest` + `supertest` — 173 tests, incl. security suites |

The app talks to a small `Db` seam (`src/db/types.ts`) with three entry points,
so identical SQL runs against node-postgres (production) or in-process PGlite
(tests) with identical RLS behaviour:

| `Db` method     | Runs as        | Used for |
| --------------- | -------------- | -------- |
| `withContext()` | `invoice_app` (RLS-subject) + tenant GUCs, in a transaction | every request that touches tenant data |
| `bypassRls()`   | `invoice_auth` (`BYPASSRLS`, `SELECT` on users+tenants only) | the pre-authentication identity lookup only |
| `privileged()`  | the connection's own role | migrations, seeding, the test harness — **never the running app** |

## Data model (`src/db/migrations/`)

- **tenants** — `id`, `name`, `slug`, `status` (`active` \| `suspended`).
- **users** — `id`, `email`, `password_hash`, `name`, `role` (`user` \| `admin`),
  `tenant_id`, `disabled_at`, `tokens_invalid_before`. `CHECK`: `user` rows have a
  tenant, `admin` rows do not.
- **invoices** — `tenant_id NOT NULL`, `UNIQUE (tenant_id, number)`.
- **audit_logs** — append-only: `actor_user_id`, `action`, `tenant_id`,
  `target_user_id`, `metadata` jsonb, `created_at`.

Migrations 001–004 build the schema; 005–007 are the hardening pass
(token revocation, audit immutability, least-privilege roles).

---

## Authentication model

- **Login** (`POST /api/auth/login`) — strict body `{ email, password }`.
  Password verified with bcrypt; an unknown email runs a dummy compare so timing
  is uniform. Failure is always a generic `401 "Invalid email or password"` — no
  account enumeration. Brute-force: an in-process fixed-window limiter (per
  `ip+email` and per `ip`) returns `429` + `Retry-After`; a success clears the
  counters. (Single-process only — see DEPLOYMENT.md for the Redis follow-up.)
- **Access tokens** — signed JWT, `30m` lifetime (`JWT_EXPIRES_IN`). Carry only
  `sub` (user id) and `ims` (ms issued-at). **`role`, `tenant_id`, `admin` and
  every other authorization fact are re-read from the database row on every
  request** — token claims are never trusted for authorization.
- **Revocation** — each user has a `tokens_invalid_before` watermark. A token
  whose `ims` predates it is rejected (`401 "Session expired"`). `POST
  /api/auth/logout` bumps the watermark for the caller (via a `SECURITY DEFINER`
  function scoped to `app.current_user_id`); disabling a user bumps it too.
- **Rejected tokens** (verified in `test/security/auth-hardening.test.ts` +
  `auth-escalation.test.ts`): expired, malformed, tampered payload, wrong signing
  key, `alg:none`, unknown/deleted user, missing/blank/lowercased-scheme
  `Authorization` header.
- **`JWT_SECRET`** — the app refuses to start in production with the dev default
  or a value shorter than 32 chars.

## Tenant isolation model

Two layers; the database is the real one.

### Layer 1 — Postgres Row-Level Security

`002_rls.sql` enables RLS on `tenants`, `users`, `invoices`;
`003_policy_hardening.sql` splits read from write; `006` locks `audit_logs`.

| Table        | Policy |
| ------------ | ------ |
| `invoices`   | `FOR ALL USING/WITH CHECK (app_is_admin() OR tenant_id = app_current_tenant())` — tenant members full CRUD within their tenant only |
| `tenants`    | `FOR SELECT` scoped to own tenant; **all writes admin-only** |
| `users`      | `FOR SELECT` scoped to own tenant; **all writes admin-only** |
| `audit_logs` | `FOR SELECT` + `FOR INSERT` admin-only; **no UPDATE/DELETE policy**, `UPDATE/DELETE` revoked from `invoice_app`, plus a `BEFORE UPDATE OR DELETE` trigger that raises for every role |

- Request handling `SET LOCAL ROLE invoice_app` and sets transaction-local
  `app.current_tenant` / `app.is_admin` / `app.current_user_id` GUCs.
- **Fail closed:** no context ⇒ `app_current_tenant()` is `NULL` ⇒ zero rows on
  every tenant-owned table (`test/security/db-privileges.test.ts`).
- **`WITH CHECK`** blocks creating or moving a row into another tenant.
- **`USING`** blocks cross-tenant `SELECT` / `UPDATE` / `DELETE`.
- **Admin** — `app.is_admin = 'true'` satisfies every policy.

### Layer 2 — application

- `authenticate` builds `req.auth` from the fresh DB row.
- Handlers wrap tenant data access in `db.withContext(req.auth, …)`.
- On create, `tenant_id` comes from the caller's context (tenant user) or an
  explicit `tenantId` (admin) — a tenant user cannot spoof another tenant
  (`400`, and `WITH CHECK` would reject it anyway).
- Cross-tenant reads return **404**, not 403 (no existence leak).

## Admin authorization

- Every `/api/admin/*` route sits behind `authenticate` **then** `requireAdmin`.
  A tenant user (even one holding a JWT stuffed with `role:"admin"` claims) gets
  `403`; unauthenticated gets `401`. `requireAdmin` reads `req.auth.isAdmin`,
  which comes from the DB row.
- Admin operations run in `db.withContext({ isAdmin: true })`, so RLS lets them
  act across tenants while still going through the same policy engine.
- The full actor × endpoint matrix is
  `test/security/authorization-matrix.test.ts` (unauthenticated, Acme user, Smith
  user, disabled user, suspended-tenant user, admin, forged-claims user — every
  admin endpoint explicitly).

## Suspension & disabled-user behaviour

| Action                | Effect |
| --------------------- | ------ |
| **Suspend tenant**    | `tenants.status = 'suspended'`. **No data is deleted.** Every request by that tenant's users — and login — returns `403 tenant_suspended` (the identity lookup joins `tenants.status`). Other tenants are unaffected. The platform admin keeps full access to the tenant through the Control Centre. |
| **Reactivate tenant** | `status = 'active'`; users regain access immediately, still scoped to their tenant. |
| **Disable user**      | Sets `disabled_at` **and** `tokens_invalid_before`. Every request / login by that user returns `403 account_disabled`. Role and `tenant_id` are never touched. |
| **Enable user**       | Clears `disabled_at` only. Tenant and role unchanged; `tokens_invalid_before` stays set so old tokens remain dead and the user signs in again. |

`test/security/authorization-matrix.test.ts` and
`test/admin/admin-security.test.ts` prove these in both directions and that
isolation holds throughout.

## Audit logging

- Actions recorded: `tenant.created`, `tenant.suspended`, `tenant.reactivated`,
  `user.created`, `user.disabled`, `user.enabled`. Each row captures **who**
  (`actor_user_id`), **what** (`action` + `metadata`), **which tenant**
  (`tenant_id`) and **when** (`created_at`).
- The audit `INSERT` runs **in the same transaction** as the change it
  describes — a failed mutation leaves no audit row
  (`test/security/audit-immutability.test.ts`).
- Genuinely append-only: no role — including the table owner or a superuser — can
  `UPDATE` or `DELETE` an audit row (grant + missing policy + trigger). Read via
  `GET /api/admin/audit-logs` (admin only).

## API surface

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |
| GET | `/health` | – | checks DB connectivity; `503` if down |
| POST | `/api/auth/login` | – | strict body; rate-limited; `429` on lockout |
| GET | `/api/auth/me` | Bearer | |
| POST | `/api/auth/logout` | Bearer | revokes the caller's tokens; `204` |
| GET | `/api/tenants` | Bearer | admin: all; user: own |
| GET | `/api/users` | Bearer | user: own tenant; admin: all + `?tenantId=` |
| GET/POST | `/api/invoices` | Bearer | scoped; admin passes `tenantId` on create |
| GET/PATCH/DELETE | `/api/invoices/:id` | Bearer | 404 across tenants; strict body |
| GET | `/api/admin/dashboard` | Admin | counts across all tenants |
| GET/POST | `/api/admin/tenants` | Admin | `?search=`, `?status=`; strict body; 409 dup slug |
| GET | `/api/admin/tenants/:id` | Admin | tenant + usage + users |
| POST | `/api/admin/tenants/:id/suspend` \| `/reactivate` | Admin | no body; 409 on no-op |
| GET/POST | `/api/admin/tenants/:id/users` | Admin | tenant from URL; password policy; one-time password |
| POST | `/api/admin/users/:id/disable` \| `/enable` | Admin | no body; 409 on no-op; admins can't be disabled |
| GET | `/api/admin/users` | Admin | all users |
| GET | `/api/admin/audit-logs` | Admin | `?tenantId=`, `?limit=` |

All write bodies use **strict** zod schemas: `tenant_id`, `role`, `disabled_at`,
`status` and any unknown key are rejected with `400`. Error responses are
generic — no SQL, driver text, stack traces or connection details ever reach the
client (`src/http/errors.ts`, `test/admin/admin-api.test.ts`).

## Production database roles

The running app connects as **`invoice_app_login`** — `LOGIN`, **not** a
superuser, **not** the schema owner, member of `invoice_app` + `invoice_auth`.
Migrations run separately as an owner role with `CREATEROLE`. Full setup, grants
and the privilege matrix are in [DEPLOYMENT.md](./DEPLOYMENT.md#1-postgresql-roles--privileges).
`test/security/db-privileges.test.ts` asserts the role attributes and that
`invoice_auth` can only read users/tenants.

## Security assumptions

- The `JWT_SECRET` is secret. Anyone holding it can mint valid tokens — hence
  server-side revocation and short expiry, but a leaked secret is still game over
  (rotate it; rotation invalidates all tokens).
- App and database clocks are roughly synced (token `ims` vs `now()` watermark).
- In production the app runs behind a TLS-terminating reverse proxy that sets a
  trustworthy `X-Forwarded-For` (the login limiter keys on `req.ip`).
- The login rate limiter is per-process; correctness of lockout across a
  multi-instance deployment needs a shared store.
- PGlite in tests is a faithful stand-in for Postgres RLS/roles, but production
  must still be run against real PostgreSQL.

## Seed data (`npm run seed`, dev only)

Tenants **Acme Ltd** / **Smith Ltd**; users `alice@acme.test` (Acme),
`bob@smith.test` (Smith), `admin@invoicecreator.test` (admin). Password
`Password123!`.

## Running

```
npm install && npm test           # no setup — in-process PGlite

docker compose up -d              # local Postgres
cp .env.example .env              # fill in DATABASE_URL / DATABASE_ADMIN_URL / JWT_SECRET
npm run migrate && npm run seed
npm run dev                       # http://localhost:3000  (admin UI at /admin)
```

## Remaining production-readiness work

- **Payments** — deliberately deferred.
- **Refresh tokens** — so access tokens can be shorter without re-login churn.
- **Shared-store rate limiting** (Redis) for multi-instance deployments.
- **Structured logging + error monitoring** — currently `console.error` only.
- **Deployment**: replace `.github/workflows/deploy.yml` (`git pull` only) with
  the pipeline in DEPLOYMENT.md; provision the Postgres roles, secret store and
  backups described there.
- **Backups / PITR** — not configured; see DEPLOYMENT.md §4.
- Admin niceties: pagination on tenant/audit lists; emailed invite links instead
  of returned one-time passwords; tenant deletion (intentionally absent for now).
