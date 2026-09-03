-- Server-side token revocation.
--
-- Access tokens stay stateless, but every user carries a `tokens_invalid_before`
-- watermark. A token is rejected when its `iat` (issued-at) predates the
-- watermark. Logout and account-disable both bump it, so an already-issued token
-- can be killed without a denylist table.

ALTER TABLE users ADD COLUMN tokens_invalid_before timestamptz;

-- A user may revoke *their own* tokens (logout) without any write privilege on
-- the users table: this SECURITY DEFINER function only ever touches the row
-- named by the server-set `app.current_user_id` GUC, and only that column.
CREATE FUNCTION revoke_tokens_for_current_user() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE users
       SET tokens_invalid_before = now()
     WHERE id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
$$;

REVOKE ALL ON FUNCTION revoke_tokens_for_current_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_tokens_for_current_user() TO invoice_app;
