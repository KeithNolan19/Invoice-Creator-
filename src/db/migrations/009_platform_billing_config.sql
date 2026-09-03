-- Platform billing — Phase 0: configuration only.
--
-- One row. Holds the platform's own business identity (for the invoices you
-- issue to tenants), the billing timings, and the platform-level Fire.com
-- credentials (encrypted — see src/crypto/secretbox.ts). Admin-only, in every
-- direction. No tenant-owned data here.
--
-- The billing data model (subscriptions, platform_invoices, payments, events,
-- notifications) lands in a later migration once its phase is approved.

CREATE TABLE platform_billing_config (
  id                          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  -- Your business identity, printed on the invoices you issue to tenants.
  business_name               text,
  business_address            text,
  business_tax_number         text,
  business_contact_email      text,

  -- Billing behaviour (editable in the admin UI, never hard-coded).
  default_currency            char(3) NOT NULL DEFAULT 'EUR',
  invoice_number_prefix       text NOT NULL DEFAULT 'VD-',
  renewal_reminder_days       integer NOT NULL DEFAULT 7  CHECK (renewal_reminder_days >= 0),
  overdue_grace_days          integer NOT NULL DEFAULT 0  CHECK (overdue_grace_days >= 0),

  -- Platform Fire.com credentials. AES-256-GCM ciphertext; nothing but the
  -- server's FireClient ever decrypts these, and only in memory for one call.
  fire_client_id_ciphertext      bytea,
  fire_client_key_ciphertext     bytea,
  fire_refresh_token_ciphertext  bytea,
  fire_webhook_private_ciphertext bytea,
  fire_webhook_kid               text,          -- the public token; safe to store plain
  fire_collection_ican           bigint,
  fire_business_id               text,          -- returned by Fire auth; shown in the UI
  fire_last_verified_at          timestamptz,
  fire_last_error                text,
  key_version                    integer,

  updated_by                  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Seed the single row so the app can always UPDATE it.
INSERT INTO platform_billing_config (id) VALUES (1);

GRANT SELECT, INSERT, UPDATE ON platform_billing_config TO invoice_app;

ALTER TABLE platform_billing_config ENABLE ROW LEVEL SECURITY;

-- Platform admin only — no tenant ever reads or writes this.
CREATE POLICY platform_billing_config_admin ON platform_billing_config
  FOR ALL
  USING (app_is_admin())
  WITH CHECK (app_is_admin());
