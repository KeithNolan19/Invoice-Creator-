-- Make audit_logs genuinely append-only.
--
-- 004 gave audit_logs a single FOR ALL admin policy. Replace it with SELECT +
-- INSERT policies only: with no UPDATE/DELETE policy those commands are denied
-- for the app role regardless of grants. A statement-level trigger then blocks
-- UPDATE/DELETE for *every* role, including the table owner and superusers.

DROP POLICY audit_logs_admin_only ON audit_logs;

CREATE POLICY audit_logs_admin_select ON audit_logs
  FOR SELECT USING (app_is_admin());

CREATE POLICY audit_logs_admin_insert ON audit_logs
  FOR INSERT WITH CHECK (app_is_admin());

REVOKE UPDATE, DELETE ON audit_logs FROM invoice_app;

CREATE FUNCTION audit_logs_immutable() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (blocked %)', TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

CREATE TRIGGER audit_logs_block_mutation
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();
