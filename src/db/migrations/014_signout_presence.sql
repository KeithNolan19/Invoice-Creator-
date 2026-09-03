-- Make sign-out take effect on the presence indicator immediately.
--
-- 013 added last_seen_at. On logout we already bump tokens_invalid_before;
-- also pull last_seen_at back a hair so it is strictly before the revocation
-- instant. Presence is then "seen recently AND last_seen_at > tokens_invalid_before",
-- so a signed-out user reads as offline at once instead of lingering for the
-- rest of the 5-minute window.

CREATE OR REPLACE FUNCTION revoke_tokens_for_current_user() RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    UPDATE users
       SET tokens_invalid_before = now(),
           last_seen_at = LEAST(COALESCE(last_seen_at, now()), now() - interval '1 second')
     WHERE id = NULLIF(current_setting('app.current_user_id', true), '')::uuid
  $$;
