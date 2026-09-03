-- Stage 1 — data model, tenant isolation and authorization foundation for the
-- customer-facing product and the (later) Fire.com payment loop.
--
-- Scope: schema + RLS + a tenant-admin authorization layer only. No Fire.com
-- calls, no QR/PDF, no UI. Credential columns are created but left unusable.
--
-- Additive and forward-only, matching the existing migration style. All new
-- tenant-owned tables get the standard RLS policy; two of them additionally
-- require a tenant-admin role for writes, enforced by a new `app.tenant_role`
-- GUC set per request (never trusted from the browser or the token).

-- ---------------------------------------------------------------------------
-- 0. RLS helper: the caller's tenant role from the request-scoped GUC.
--    Mirrors app_current_tenant() / app_is_admin() from 002.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_tenant_role() RETURNS text
  LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.tenant_role', true), '')
$$;

-- ---------------------------------------------------------------------------
-- 1. users.tenant_role  (admin | member)  — distinct from the platform `role`.
--    Backfill: every EXISTING tenant user becomes a tenant admin. Before this
--    migration there is no member/admin split — a tenant user could already do
--    everything a tenant admin now can — so promoting them all is the
--    non-breaking choice (nobody loses access). It is NOT platform admin.
--    New users created after this get their role set explicitly by the
--    provisioning / invitation flow (first user = admin, invitee = member).
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN tenant_role text;

UPDATE users SET tenant_role = 'admin' WHERE role = 'user';

ALTER TABLE users DROP CONSTRAINT users_tenant_matches_role;

-- Explicit NULL handling: a bare `tenant_role IN (...)` is NULL (not false) when
-- tenant_role is NULL, and a CHECK passes on NULL — so guard with IS NOT NULL.
ALTER TABLE users ADD CONSTRAINT users_role_consistency CHECK (
  (role = 'admin'
     AND tenant_id IS NULL
     AND tenant_role IS NULL)
  OR
  (role = 'user'
     AND tenant_id IS NOT NULL
     AND tenant_role IS NOT NULL
     AND tenant_role IN ('admin', 'member'))
);

-- ---------------------------------------------------------------------------
-- 2. customers
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(btrim(name)) > 0),
  email         text,
  address_line1 text,
  address_line2 text,
  city          text,
  region        text,
  postal_code   text,
  country       text,
  tax_number    text,
  notes         text,
  archived_at   timestamptz,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX customers_tenant_id_idx   ON customers (tenant_id);
CREATE INDEX customers_tenant_name_idx ON customers (tenant_id, lower(name));
CREATE UNIQUE INDEX customers_tenant_email_uk
  ON customers (tenant_id, lower(email))
  WHERE email IS NOT NULL AND archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. invoices — payment-supporting columns + a (id, tenant_id) unique key so
--    line items can reference their invoice AND tenant together (a line item
--    can never point at an invoice in another tenant).
-- ---------------------------------------------------------------------------
ALTER TABLE invoices ADD CONSTRAINT invoices_id_tenant_uk UNIQUE (id, tenant_id);

ALTER TABLE invoices
  ADD COLUMN customer_id        uuid REFERENCES customers (id) ON DELETE RESTRICT,
  ADD COLUMN subtotal_cents     bigint CHECK (subtotal_cents >= 0),
  ADD COLUMN discount_cents     bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  ADD COLUMN tax_cents          bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  ADD COLUMN total_cents        bigint CHECK (total_cents >= 0),
  ADD COLUMN notes              text,
  ADD COLUMN payment_terms      text,
  -- Payment status is a lifecycle of its own (driven later by Fire.com's async
  -- settlement), kept separate from the document `status` column above.
  --   unpaid  -> issued, no confirmed payment              (customer sees UNPAID)
  --   pending -> a payment is in flight at the provider     (customer sees UNPAID)
  --   paid    -> provider confirmed funds received          (customer sees PAID)
  -- `pending` is required for the Fire.com workflow: Open Banking payments
  -- settle asynchronously, so there is a window between the payer authorising
  -- and funds landing during which the invoice is neither cleanly unpaid nor
  -- paid; showing PAID then would be wrong.
  ADD COLUMN payment_status     text NOT NULL DEFAULT 'unpaid'
                                  CHECK (payment_status IN ('unpaid', 'pending', 'paid')),
  ADD COLUMN payment_provider   text CHECK (payment_provider IN ('fire')),
  ADD COLUMN payment_reference  text,
  ADD COLUMN fire_payment_code  text,
  ADD COLUMN qr_generated_at    timestamptz,
  ADD COLUMN paid_at            timestamptz,
  ADD COLUMN paid_amount_cents  bigint CHECK (paid_amount_cents >= 0),
  ADD COLUMN paid_currency      char(3),
  -- Captured at finalise so an issued invoice / its PDF is immutable.
  ADD COLUMN business_snapshot  jsonb,
  ADD COLUMN customer_snapshot  jsonb;

UPDATE invoices SET
  subtotal_cents   = amount_cents,
  total_cents      = amount_cents,
  payment_status   = CASE WHEN status = 'paid' THEN 'paid' ELSE 'unpaid' END,
  paid_at          = CASE WHEN status = 'paid' THEN created_at  ELSE NULL END,
  paid_amount_cents = CASE WHEN status = 'paid' THEN amount_cents ELSE NULL END,
  paid_currency    = CASE WHEN status = 'paid' THEN currency     ELSE NULL END;

CREATE UNIQUE INDEX invoices_tenant_payment_reference_uk
  ON invoices (tenant_id, payment_reference)
  WHERE payment_reference IS NOT NULL;
CREATE INDEX invoices_tenant_payment_status_idx ON invoices (tenant_id, payment_status);
CREATE INDEX invoices_customer_id_idx           ON invoices (customer_id);

-- ---------------------------------------------------------------------------
-- 4. invoice_line_items — tenant_id is denormalised for RLS; the composite FK
--    guarantees it always matches the parent invoice's tenant.
-- ---------------------------------------------------------------------------
CREATE TABLE invoice_line_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL,
  tenant_id        uuid NOT NULL,
  position         integer NOT NULL DEFAULT 0 CHECK (position >= 0),
  description      text NOT NULL CHECK (length(btrim(description)) > 0),
  quantity         numeric(14, 3) NOT NULL CHECK (quantity >= 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  tax_rate         numeric(6, 4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 1),
  discount_cents   bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_items_invoice_fk
    FOREIGN KEY (invoice_id, tenant_id)
    REFERENCES invoices (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX invoice_line_items_invoice_id_idx ON invoice_line_items (invoice_id);
CREATE INDEX invoice_line_items_tenant_id_idx  ON invoice_line_items (tenant_id);
CREATE UNIQUE INDEX invoice_line_items_invoice_position_uk
  ON invoice_line_items (invoice_id, position);

-- ---------------------------------------------------------------------------
-- 5. tenant_settings — one row per tenant. Business identity + invoice defaults.
--    Every tenant member may READ it (invoice defaults, the business block);
--    only a tenant admin may WRITE it.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_settings (
  tenant_id             uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  business_name         text,
  address_line1         text,
  address_line2         text,
  city                  text,
  region                text,
  postal_code           text,
  country               text,
  contact_email         text,
  contact_phone         text,
  tax_number            text,
  tax_scheme            text,
  default_currency      char(3) NOT NULL DEFAULT 'EUR',
  default_due_days      integer NOT NULL DEFAULT 14 CHECK (default_due_days >= 0),
  default_notes         text,
  default_payment_terms text,
  invoice_number_prefix text NOT NULL DEFAULT 'INV-',
  next_invoice_number   bigint NOT NULL DEFAULT 1 CHECK (next_invoice_number >= 1),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO tenant_settings (tenant_id, business_name)
  SELECT id, name FROM tenants
  ON CONFLICT (tenant_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. tenant_payment_integrations — per-tenant Fire.com configuration.
--    STRUCTURE ONLY. The *_ciphertext columns are opaque bytea holding
--    app-level AES-256-GCM ciphertext; nothing decrypts or uses them yet.
--    Only the fields the verified Fire.com integration design needs:
--      auth:    client_id, client_key, refresh_token          (secret)
--      webhook: webhook_secret (HS256 signing key), webhook_kid (safe)
--      target:  collection_ican + collection_account_alias
--      safe:    fire_business_id (returned by Fire's auth, shown in the UI)
--    Tenant admins only, for every operation.
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_payment_integrations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider                 text NOT NULL DEFAULT 'fire' CHECK (provider IN ('fire')),
  status                   text NOT NULL DEFAULT 'not_connected'
                             CHECK (status IN ('not_connected', 'pending', 'connected', 'error')),
  client_id_ciphertext     bytea,
  client_key_ciphertext    bytea,
  refresh_token_ciphertext bytea,
  webhook_secret_ciphertext bytea,
  key_version              integer,
  fire_business_id         text,
  collection_ican          bigint,
  collection_account_alias text,
  webhook_kid              text,
  last_verified_at         timestamptz,
  last_error               text,
  connected_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE INDEX tenant_payment_integrations_tenant_id_idx ON tenant_payment_integrations (tenant_id);

-- ---------------------------------------------------------------------------
-- 7. Grants for the RLS-subject app role.
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON customers, invoice_line_items, tenant_settings, tenant_payment_integrations
  TO invoice_app;

-- ---------------------------------------------------------------------------
-- 8. Row-Level Security.
-- ---------------------------------------------------------------------------
ALTER TABLE customers                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_settings             ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_payment_integrations ENABLE ROW LEVEL SECURITY;

-- customers: any member of the tenant, full CRUD; scoped to the tenant.
CREATE POLICY customers_isolation ON customers
  FOR ALL
  USING (app_is_admin() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_admin() OR tenant_id = app_current_tenant());

-- invoice_line_items: same. WITH CHECK stops a line item being written into
-- another tenant; the composite FK stops it referencing another tenant's invoice.
CREATE POLICY invoice_line_items_isolation ON invoice_line_items
  FOR ALL
  USING (app_is_admin() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_admin() OR tenant_id = app_current_tenant());

-- tenant_settings: members read their own tenant; only tenant admins write.
CREATE POLICY tenant_settings_read ON tenant_settings
  FOR SELECT
  USING (app_is_admin() OR tenant_id = app_current_tenant());

CREATE POLICY tenant_settings_admin_write ON tenant_settings
  FOR ALL
  USING (app_is_admin()
         OR (tenant_id = app_current_tenant() AND app_tenant_role() = 'admin'))
  WITH CHECK (app_is_admin()
         OR (tenant_id = app_current_tenant() AND app_tenant_role() = 'admin'));

-- tenant_payment_integrations: tenant admins only, for everything — a member's
-- context sees no rows and cannot write.
CREATE POLICY tenant_payment_integrations_admin ON tenant_payment_integrations
  FOR ALL
  USING (app_is_admin()
         OR (tenant_id = app_current_tenant() AND app_tenant_role() = 'admin'))
  WITH CHECK (app_is_admin()
         OR (tenant_id = app_current_tenant() AND app_tenant_role() = 'admin'));

-- ---------------------------------------------------------------------------
-- 9. Atomic per-tenant invoice-number allocation.
--    Members create invoices, so they must be able to bump the counter — but
--    the counter lives in the admin-write tenant_settings table. This
--    SECURITY DEFINER function is the only way a member touches that column:
--    it re-checks the caller's tenant context and only ever changes
--    next_invoice_number. (Not wired into any route yet — Stage 5.)
-- ---------------------------------------------------------------------------
CREATE FUNCTION allocate_invoice_number(p_tenant uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prefix text;
  v_number bigint;
BEGIN
  IF NOT (app_is_admin() OR p_tenant = app_current_tenant()) THEN
    RAISE EXCEPTION 'not permitted for this tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE tenant_settings
     SET next_invoice_number = next_invoice_number + 1,
         updated_at = now()
   WHERE tenant_id = p_tenant
   RETURNING invoice_number_prefix, next_invoice_number - 1
        INTO v_prefix, v_number;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no settings row for tenant %', p_tenant;
  END IF;

  RETURN v_prefix || v_number::text;
END
$$;

REVOKE ALL ON FUNCTION allocate_invoice_number(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION allocate_invoice_number(uuid) TO invoice_app;

-- ---------------------------------------------------------------------------
-- 10. Tenant-admin: change a member's role within their own tenant.
--     The `users` write policy (from 003) is platform-admin-only; this
--     SECURITY DEFINER function is the narrow, audited-at-the-route escape
--     hatch. It re-checks the caller is a tenant admin of the target's tenant
--     (from the request-scoped GUCs) and only ever touches `tenant_role` of a
--     `role = 'user'` row in that tenant. Returns the target's tenant_id, or
--     NULL when nothing matched.
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_tenant_member_role(p_user uuid, p_role text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
BEGIN
  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'invalid tenant role: %', p_role;
  END IF;

  IF NOT (app_tenant_role() = 'admin' AND app_current_tenant() IS NOT NULL) THEN
    RAISE EXCEPTION 'not a tenant admin' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE users
     SET tenant_role = p_role
   WHERE id = p_user
     AND role = 'user'
     AND tenant_id = app_current_tenant()
   RETURNING tenant_id INTO v_tenant;

  RETURN v_tenant;
END
$$;

REVOKE ALL ON FUNCTION set_tenant_member_role(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tenant_member_role(uuid, text) TO invoice_app;
