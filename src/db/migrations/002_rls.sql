-- Row-Level Security: the real enforcement point for tenant isolation.
--
-- Request handling runs as the unprivileged role `invoice_app` with two GUCs
-- set for the transaction:
--   app.current_tenant  -> the caller's tenant uuid ('' / unset for admins)
--   app.is_admin        -> 'true' for platform admins
-- Migrations, seeding and the pre-login user lookup run as the connection's
-- own (privileged) role, which bypasses RLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'invoice_app') THEN
    CREATE ROLE invoice_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO invoice_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants, users, invoices TO invoice_app;

-- Allow the current (migrating) role to `SET ROLE invoice_app` at request time.
GRANT invoice_app TO CURRENT_USER;

CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

CREATE FUNCTION app_is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT COALESCE(NULLIF(current_setting('app.is_admin', true), '')::boolean, false)
$$;

CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

ALTER TABLE tenants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- tenants: admins see all; a user sees only their own tenant row.
CREATE POLICY tenants_isolation ON tenants
  USING (app_is_admin() OR id = app_current_tenant());

-- users: admins see all; a user sees only accounts within their own tenant.
CREATE POLICY users_isolation ON users
  USING (app_is_admin() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_admin() OR tenant_id = app_current_tenant());

-- invoices: admins see all; a user sees only their tenant's invoices, and can
-- never write a row belonging to another tenant.
CREATE POLICY invoices_isolation ON invoices
  USING (app_is_admin() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_admin() OR tenant_id = app_current_tenant());
