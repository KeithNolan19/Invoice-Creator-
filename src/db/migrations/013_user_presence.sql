-- User presence — "is this person currently signed in?"
--
-- Access tokens are stateless, so "signed in" is really "seen recently": every
-- authenticated request bumps `last_seen_at` (throttled to once a minute), and
-- the admin UI treats a user seen within a few minutes as online.
--
-- The write happens in the pre-context `authenticate` middleware, which runs as
-- the narrow BYPASSRLS `invoice_auth` role, so — like token revocation in 005 —
-- it goes through a SECURITY DEFINER function scoped to a single row + column.

ALTER TABLE users ADD COLUMN last_seen_at  timestamptz;
ALTER TABLE users ADD COLUMN last_login_at timestamptz;

-- Bump last_seen_at for one user, at most once per minute (cheap no-op query
-- the rest of the time). Only ever touches that one column on that one row.
CREATE FUNCTION touch_user_last_seen(p_user_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE users
       SET last_seen_at = now()
     WHERE id = p_user_id
       AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')
  $$;

-- Record a successful login (also counts as being seen).
CREATE FUNCTION record_user_login(p_user_id uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE users SET last_login_at = now(), last_seen_at = now() WHERE id = p_user_id
  $$;

REVOKE ALL ON FUNCTION touch_user_last_seen(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION record_user_login(uuid)    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_user_last_seen(uuid) TO invoice_auth, invoice_app;
GRANT EXECUTE ON FUNCTION record_user_login(uuid)    TO invoice_auth, invoice_app;
