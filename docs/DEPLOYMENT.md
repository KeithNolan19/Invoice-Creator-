# Deployment & Operations — Production Readiness

Status: **not production-ready to auto-deploy.** This document is the checklist of
what must exist first. Nothing here provisions infrastructure or ships anything.

---

## 1. PostgreSQL roles & privileges

The application **must not** connect as a superuser or as the schema owner.
Migrations create four roles (see `007_least_privilege_roles.sql`):

| Role                | Attributes                     | Privileges                                                                 | Used by |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------- | ------- |
| `invoice_owner` *(you create this)* | `LOGIN`, owns the schema, `CREATEROLE` | DDL. Runs `npm run migrate` / `npm run seed`. | deploy step only |
| `invoice_app`       | `NOLOGIN`, **RLS-subject**     | `SELECT/INSERT/UPDATE/DELETE` on `tenants,users,invoices` (policy-scoped); `SELECT,INSERT` on `audit_logs` | request handling (`SET LOCAL ROLE`) |
| `invoice_auth`      | `NOLOGIN`, `BYPASSRLS`         | `SELECT` on `users,tenants` **only**                                      | pre-authentication identity lookup |
| `invoice_app_login` | `LOGIN`, **not** superuser, **not** `BYPASSRLS`, member of `invoice_app` + `invoice_auth` | none directly — it `SET LOCAL ROLE`s to the two above | the running app (`DATABASE_URL`) |

### Production setup (run once, as a superuser)

```sql
-- 1. an owner/migration role
CREATE ROLE invoice_owner LOGIN PASSWORD '<generated>' CREATEROLE;
CREATE DATABASE invoice_creator OWNER invoice_owner;

-- 2. run migrations AS invoice_owner (they CREATE the app roles):
--    DATABASE_ADMIN_URL=postgres://invoice_owner:...@host/invoice_creator npm run migrate

-- 3. give the login role a password + LOGIN (migrations create it NOLOGIN):
ALTER ROLE invoice_app_login WITH LOGIN PASSWORD '<generated>';
```

`DATABASE_URL` → `invoice_app_login`. `DATABASE_ADMIN_URL` → `invoice_owner`
(only referenced by the migrate/seed scripts, never at request time). The app
process auto-migrates only when `NODE_ENV !== production`; in production migrations
are an explicit deploy step.

### What RLS guarantees (verified by `test/security/db-privileges.test.ts`)

- No tenant context ⇒ **zero rows** on every tenant-owned table (fail closed).
- Tenant users cannot `INSERT/UPDATE/DELETE` `tenants`, `users` or `audit_logs`.
- `WITH CHECK` blocks creating or moving a row into another tenant.
- `USING` blocks cross-tenant `SELECT`/`UPDATE`/`DELETE`.
- `audit_logs` is append-only: no `UPDATE`/`DELETE` policy, `UPDATE/DELETE`
  revoked from `invoice_app`, and a `BEFORE UPDATE OR DELETE` trigger that raises
  for **every** role including the owner.

---

## 2. Secrets & configuration

| Variable              | Required | Notes |
| --------------------- | -------- | ----- |
| `DATABASE_URL`        | yes      | `invoice_app_login` connection string |
| `DATABASE_ADMIN_URL`  | deploy   | `invoice_owner`; migrate/seed only |
| `JWT_SECRET`          | yes      | ≥ 32 chars. The app **refuses to boot** in production with the dev default or a short value. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `JWT_EXPIRES_IN`      | no       | default `30m` |
| `LOGIN_MAX_PER_IDENTITY` / `LOGIN_MAX_PER_IP` / `LOGIN_WINDOW_MS` | no | login rate-limit tuning |
| `PORT`                | no       | default 3000 |

- `.env` and `.env.*` are git-ignored (`!.env.example` kept). Verified by
  `test/security/secrets.test.ts`, which also scans `src/` and `web/` for
  connection strings / keys and asserts the served admin bundle contains none.
- Put real secrets in the platform secret store / GitHub Actions secrets — never
  in the repo, the image, or the frontend.
- Behind a reverse proxy, `trust proxy` is enabled in production so `req.ip`
  (used by the login limiter) reflects the real client. Ensure the proxy sets
  `X-Forwarded-For` and strips client-supplied values.

---

## 3. Deployment pipeline — required steps

The current `.github/workflows/deploy.yml` only does `git pull` on the VPS. That
is **not sufficient**. A safe pipeline needs, in order:

1. **Checkout** the release commit.
2. **`npm ci`** — clean, lockfile-exact install.
3. **`npm run typecheck`** and **`npm test`** — block the deploy on any failure
   (173 tests, incl. the security + mutation-verified suites).
4. **Build** — currently the app runs via `tsx` (no build). If a compiled build
   is introduced, run it here and deploy the artifact, not the source tree.
5. **Provision secrets/env** on the target from the secret store (never commit).
6. **Database migrations** — `DATABASE_ADMIN_URL=… npm run migrate` as
   `invoice_owner`. Migrations are forward-only and each runs in its own
   transaction; a failed migration aborts the deploy before the app restarts.
7. **Restart** the app process (systemd / pm2 / container) against the new code.
8. **Health check** — poll `GET /health` (checks DB connectivity via the
   `invoice_auth` role) until `200 {"status":"ok"}`; fail the deploy on timeout.
9. **Smoke** — an unauthenticated request is `401`, `GET /admin/` serves the UI.

Do **not** add a production deploy workflow until: the target host, a managed or
self-hosted Postgres with the role setup above, the secret store, and a process
supervisor all exist. Until then this file is the runbook.

### Rollback

- **Code:** redeploy the previous release tag (steps 1–4, 7–9). Keep the last
  known-good release available (tag or artifact).
- **Database:** migrations are forward-only. Every migration in this codebase so
  far is **additive** (new columns/tables/policies) and backward-compatible with
  the previous app version, so a code-only rollback is safe. Before shipping any
  destructive migration (column drop/rename), gate it behind a two-phase
  expand/contract release so rollback never needs a down-migration.
- If a bad migration corrupts data, restore from backup (§4) — accept the RPO
  window rather than hand-editing production rows.

---

## 4. Backup & recovery (Postgres)

Not yet configured. Requirements for production:

### Automated backups
- **Continuous WAL archiving + daily base backup** (managed provider PITR, or
  `pgBackRest` / `wal-g` to object storage). Nightly `pg_dump` alone is a weak
  fallback — it loses up to 24h and locks less cleanly at scale.
- Backups encrypted at rest, stored in a **different** region/account from the
  primary. Restrict read access.

### Retention
- Point-in-time recovery window: **≥ 7 days**.
- Daily full backups: 7–14 days. Weekly: 4–8 weeks. Monthly: 6–12 months if
  compliance requires it.

### Restore procedure
1. Provision a fresh Postgres instance (do **not** overwrite the primary).
2. Restore the latest base backup; replay WAL to the target timestamp.
3. Run `ALTER ROLE invoice_app_login …` if roles are not in the backup.
4. Point a **staging** app at it; run `GET /health` + the smoke checks.
5. Repoint `DATABASE_URL` (or promote) once verified. Update DNS / connection
   string; restart app.

### Restore testing
- **Quarterly restore drill** into a scratch environment, timed, with the result
  recorded (actual RTO). A backup that has never been restored is not a backup.

### Availability during restore
- In-place PITR restore ⇒ the database is **down** for the restore duration
  (RTO). Plan a maintenance window; the app returns `503` from `/health` and
  errors on data routes meanwhile.
- Restore-to-new-instance + repoint ⇒ downtime is just the cutover (seconds to
  minutes), at the cost of losing writes between the restore point and cutover.
- Publish the target **RPO** (≤ 5 min with WAL archiving) and **RTO** (drill
  result) to stakeholders.

---

## 5. Still required before production

- Refresh tokens (so access tokens can be even shorter without re-login churn).
- Shared-store login rate limiting (Redis) once the app runs on > 1 process/host;
  the current limiter is per-process in-memory.
- Structured request logging + error monitoring (Sentry/OTel) — errors are
  currently `console.error` only.
- The Postgres role/backup/secret-store infrastructure described above.
- A real deploy workflow replacing `git pull`.
- Security headers / HTTPS termination / HSTS at the proxy.
