-- Least-privilege roles for the running application.
--
-- The app process connects as `invoice_app_login` — NOT a superuser, NOT the
-- schema owner. It is a member of exactly two roles:
--
--   invoice_app   (from 002)  RLS-subject. Request-scoped queries `SET LOCAL
--                             ROLE invoice_app` and run under the tenant GUCs.
--   invoice_auth              BYPASSRLS, but granted only SELECT on users +
--                             tenants. Used *solely* for the pre-authentication
--                             identity lookup (no tenant context exists yet).
--
-- Migrations and seeding run as a separate admin/owner role (needs CREATE on the
-- schema + CREATEROLE), never as the app role. See docs/DEPLOYMENT.md.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invoice_auth') THEN
    CREATE ROLE invoice_auth NOLOGIN BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invoice_app_login') THEN
    -- Production flips this to: ALTER ROLE invoice_app_login WITH LOGIN PASSWORD '…'
    CREATE ROLE invoice_app_login NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO invoice_auth;
GRANT SELECT ON tenants, users TO invoice_auth;

GRANT invoice_app  TO invoice_app_login;
GRANT invoice_auth TO invoice_app_login;

-- Let the migrating role (and the test harness superuser) SET LOCAL ROLE to
-- these for verification.
GRANT invoice_auth, invoice_app_login TO CURRENT_USER;
