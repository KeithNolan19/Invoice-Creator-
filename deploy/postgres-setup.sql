-- One-time PostgreSQL bootstrap for a production Invoice Creator host.
-- Run this ONCE, connected as the `postgres` superuser, BEFORE the first
-- migration:
--
--   sudo -u postgres psql \
--     -v owner_pw="$(openssl rand -base64 24)" \
--     -v app_pw="$(openssl rand -base64 24)" \
--     -f deploy/postgres-setup.sql
--
-- Record the two generated passwords — `owner_pw` goes in
-- /etc/invoice-creator/admin.env (DATABASE_ADMIN_URL), `app_pw` goes in
-- /etc/invoice-creator/app.env (DATABASE_URL). See docs/DEPLOYMENT.md.
--
-- The application NEVER connects with either the superuser or `invoice_owner`.
-- It connects as `invoice_app_login` (created NOLOGIN by migration 007 and
-- given LOGIN + a password at the end of this script).

\set ON_ERROR_STOP on

-- Owner / migration role. Needs CREATEROLE because the migrations themselves
-- CREATE the three application roles (invoice_app, invoice_auth,
-- invoice_app_login). It is not a superuser and has no BYPASSRLS.
CREATE ROLE invoice_owner LOGIN PASSWORD :'owner_pw' CREATEROLE;

CREATE DATABASE invoice_creator OWNER invoice_owner;

\connect invoice_creator

-- On PostgreSQL 15+ the `public` schema is not writable by the database owner
-- by default. Hand it to invoice_owner so `npm run migrate` can create objects.
ALTER SCHEMA public OWNER TO invoice_owner;

-- ---------------------------------------------------------------------------
-- STOP. Now run the migrations as invoice_owner (this creates invoice_app,
-- invoice_auth and invoice_app_login):
--
--   set -a; . /etc/invoice-creator/app.env; . /etc/invoice-creator/admin.env; set +a
--   npm run migrate
--
-- Then come back and run the statement below (as the postgres superuser or as
-- invoice_owner) to let the app role actually log in:
--
--   sudo -u postgres psql -d invoice_creator \
--     -v app_pw='<the app_pw from above>' \
--     -c "ALTER ROLE invoice_app_login WITH LOGIN PASSWORD :'app_pw'"
-- ---------------------------------------------------------------------------
