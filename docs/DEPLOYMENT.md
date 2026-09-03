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

## 3. The vibedev.ie runbook (single VPS)

Target: one Ubuntu VPS (`144.126.231.104`, DNS `vibedev.ie`) running PostgreSQL,
the Node app under systemd, and nginx terminating TLS. All config templates are
in [`deploy/`](../deploy/). The app runs straight from source via `tsx` (no build
step).

> The old `.github/workflows/deploy.yml` only runs `git pull` — it never installs
> deps, migrates, or restarts anything. That is why a push appeared to "do
> nothing". Deploys are now the manual [`scripts/deploy.sh`](../scripts/deploy.sh);
> the workflow is left untouched for now (see §3.3).

### 3.1 First-time provisioning (once)

[`deploy/provision.sh`](../deploy/provision.sh) does the whole thing and is
idempotent (safe to re-run). On the VPS as root:

```bash
curl -fsSL https://raw.githubusercontent.com/KeithNolan19/Invoice-Creator-/main/deploy/provision.sh \
  | sudo CERTBOT_EMAIL=you@example.com ADMIN_EMAIL=you@example.com bash
```

It installs packages + Node 24, creates the `invoice` system user, clones the
repo to `/var/www/invoice-creator`, generates the DB passwords + `JWT_SECRET`
(written once to `/etc/invoice-creator/{app,admin}.env`, never rotated on
re-run), creates the `invoice_owner` role + `invoice_creator` database, runs
`npm ci` + migrations, sets the `invoice_app_login` password, installs and starts
the systemd service, health-checks it, creates the platform admin (password
generated and printed **once** unless `ADMIN_PASSWORD` is set), swaps the nginx
site in (removing the old mockup), and runs certbot for TLS.

Then lock the firewall (Postgres stays on localhost, never opened):

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

Individual templates ([`postgres-setup.sql`](../deploy/postgres-setup.sql),
[`invoice-creator.service`](../deploy/invoice-creator.service),
[`invoice-creator.nginx`](../deploy/invoice-creator.nginx),
[`app.env.example`](../deploy/app.env.example),
[`admin.env.example`](../deploy/admin.env.example)) are there if you'd rather do
it by hand — `provision.sh` is just those steps wired together.

### 3.2 Every deploy after that

```bash
sudo /var/www/invoice-creator/scripts/deploy.sh
```

It does: `git reset --hard origin/main` → `npm ci` → `npm run typecheck` →
`npm run migrate` (as `invoice_owner`, forward-only) → `systemctl restart
invoice-creator` → poll `/health`, failing the deploy on timeout. It does **not**
run `npm test` (vitest + PGlite is memory-heavy) — running `npm test` green
locally on the commit you're shipping is the precondition.

### 3.3 The GitHub Actions workflow

`.github/workflows/deploy.yml` still SSHes in and runs `git pull` on every push
to `main`. With `deploy.sh` doing `git reset --hard` this is redundant, and a lone
`git pull` is what leaves the box in a half-updated state (new files, old
process, un-migrated DB). Recommended: delete the workflow, or cut it down to a
CI-only `npm ci && npm run typecheck && npm test` check with no SSH step. Not
changed here pending that call.

### 3.4 First login

The platform admin created above signs in at **`https://vibedev.ie/admin/`** —
*not* `/app/`. `requireTenantUser` blocks platform admins from the customer app
by design. From the Admin Control Centre the admin creates the first tenant and
its tenant-admin user; that user then signs in at `https://vibedev.ie/app/`
(which is also where `https://vibedev.ie/` redirects).

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

### Interim: nightly `pg_dump` (single-VPS setup)

Until the WAL-archiving setup below exists, run a nightly encrypted dump copied
off the box. This loses up to ~24h on restore — acceptable only for the current
low-stakes state, not a target.

```bash
# /etc/cron.d/invoice-creator-backup  (runs as postgres)
30 3 * * * postgres pg_dump -Fc invoice_creator | \
  age -r <recipient> -o /var/backups/invoice-creator/$(date +\%F).dump.age && \
  rclone copy /var/backups/invoice-creator remote:invoice-creator-backups
```

Test the restore quarterly into a scratch database (`pg_restore` → point a
staging app at it → `/health` + smoke). A dump that has never been restored is
not a backup.

### Target: automated backups
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
- WAL-archiving / PITR backups (§4) — the nightly `pg_dump` is interim only.
- A secret store (env files on the box are the current mechanism).
- CI that runs `npm test` on every push, and retiring the `git pull` workflow
  (§3.3).
- Moving Postgres off the app VPS once load or availability needs it.
- **The current droplet is 512 MB RAM.** `provision.sh` adds a 2 GB swapfile and
  tunes Postgres down (`shared_buffers=64MB`), and the service has
  `MemoryHigh/Max` back-pressure — but running `tsc` and `tsx` on that box is
  tight. Introduce a compiled build (ship `dist/`, drop `tsx` + devDeps at
  runtime) or resize to 1 GB before real traffic.

Now in place (§3): least-privilege DB roles, non-superuser app connection,
manual migrate-and-restart deploy with health check, HTTPS/HSTS + security
headers at nginx.
