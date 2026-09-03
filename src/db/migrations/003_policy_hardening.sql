-- Harden the RLS policies before the security review.
--
-- 002 gave every table a single FOR ALL policy scoped to the caller's tenant.
-- That means a tenant user could (if an endpoint ever exposed it, or via any
-- SQL path) UPDATE their own tenant row or their own user row — including
-- `role` — as long as tenant_id still matched. Split read from write:
--   * tenants / users : tenant members may SELECT their own; only admins write.
--   * invoices        : tenant members keep full CRUD within their own tenant.

DROP POLICY tenants_isolation ON tenants;
DROP POLICY users_isolation ON users;
DROP POLICY invoices_isolation ON invoices;

-- tenants -----------------------------------------------------------------
CREATE POLICY tenants_select ON tenants
  FOR SELECT
  USING (app_is_admin() OR id = app_current_tenant());

CREATE POLICY tenants_admin_write ON tenants
  FOR ALL
  USING (app_is_admin())
  WITH CHECK (app_is_admin());

-- users -------------------------------------------------------------------
CREATE POLICY users_select ON users
  FOR SELECT
  USING (app_is_admin() OR tenant_id = app_current_tenant());

CREATE POLICY users_admin_write ON users
  FOR ALL
  USING (app_is_admin())
  WITH CHECK (app_is_admin());

-- invoices --------------------------------------------------------------
-- Tenant members keep full CRUD, but only within their own tenant. The USING
-- clause scopes SELECT/UPDATE/DELETE; the WITH CHECK clause is what stops a row
-- being created in — or moved into — another tenant. Admins are unrestricted.
CREATE POLICY invoices_isolation ON invoices
  FOR ALL
  USING (app_is_admin() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_admin() OR tenant_id = app_current_tenant());
