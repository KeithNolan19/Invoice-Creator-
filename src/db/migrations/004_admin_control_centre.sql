-- Admin Control Centre: tenant lifecycle, user disable, and an append-only
-- audit log. RLS model is unchanged in spirit — audit_logs is admin-only, and
-- the new columns are covered by the existing tenant/user policies.

-- Tenant lifecycle -----------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended'));

-- User disable (nullable timestamp; NULL = active) --------------------------
ALTER TABLE users
  ADD COLUMN disabled_at timestamptz;

-- Audit log ----------------------------------------------------------------
CREATE TABLE audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid REFERENCES users (id) ON DELETE SET NULL,
  action         text NOT NULL,
  tenant_id      uuid REFERENCES tenants (id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_tenant_id_idx  ON audit_logs (tenant_id);
CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at DESC);

-- Append-only: the app role may read and insert, never update or delete.
GRANT SELECT, INSERT ON audit_logs TO invoice_app;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_admin_only ON audit_logs
  FOR ALL
  USING (app_is_admin())
  WITH CHECK (app_is_admin());
