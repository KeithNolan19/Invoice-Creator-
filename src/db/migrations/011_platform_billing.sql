-- Platform billing — Phase 1: the data model.
--
-- Platform -> tenant subscription billing. Distinct from the tenant `invoices`
-- table (tenant -> its own customers): these tables are only ever written by the
-- platform admin or trusted system context, and a tenant can only READ its own
-- rows. See docs/PLATFORM_BILLING_DESIGN.md.
--
-- Additive and forward-only. All new tables get RLS.

-- ---------------------------------------------------------------------------
-- 0. config: the yearly discount
-- ---------------------------------------------------------------------------
ALTER TABLE platform_billing_config
  ADD COLUMN yearly_discount_pct numeric(5,2) NOT NULL DEFAULT 5
    CHECK (yearly_discount_pct >= 0 AND yearly_discount_pct < 100);

-- ---------------------------------------------------------------------------
-- 1. tenants: suspension reason + reactivation trail
-- ---------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN suspension_reason text CHECK (suspension_reason IN ('unpaid', 'other')),
  ADD COLUMN suspended_at      timestamptz,
  ADD COLUMN suspended_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN reactivated_at    timestamptz,
  ADD COLUMN reactivation_note text;

-- ---------------------------------------------------------------------------
-- 2. subscription_plans — the catalogue you sell. Priced per user-count tier.
-- ---------------------------------------------------------------------------
CREATE TABLE subscription_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  max_users     integer NOT NULL CHECK (max_users > 0),
  monthly_cents bigint NOT NULL CHECK (monthly_cents >= 0),
  currency      char(3) NOT NULL DEFAULT 'EUR',
  sort_order    integer NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO subscription_plans (code, name, max_users, monthly_cents, sort_order) VALUES
  ('starter',  'Starter',  5,  1000, 1),
  ('team',     'Team',     10, 1500, 2),
  ('business', 'Business', 15, 2000, 3)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. tenant_subscriptions — one per tenant. amount_cents is the resolved
--    snapshot (monthly, or monthly*12*(1 - discount) for yearly).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  plan_id              uuid NOT NULL REFERENCES subscription_plans (id) ON DELETE RESTRICT,
  billing_interval     text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year')),
  amount_cents         bigint NOT NULL CHECK (amount_cents >= 0),
  currency             char(3) NOT NULL DEFAULT 'EUR',
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  current_period_start date NOT NULL,
  current_period_end   date NOT NULL,
  renewal_date         date NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  started_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end >= current_period_start)
);

CREATE INDEX tenant_subscriptions_renewal_idx ON tenant_subscriptions (renewal_date)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 4. platform_invoices — the invoice you issue to a tenant.
-- ---------------------------------------------------------------------------
CREATE SEQUENCE platform_invoice_seq START 1;

CREATE TABLE platform_invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number            text NOT NULL UNIQUE,
  subscription_id   uuid REFERENCES tenant_subscriptions (id) ON DELETE SET NULL,
  kind              text NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription', 'adhoc')),
  period_start      date,
  period_end        date,
  issue_date        date NOT NULL DEFAULT CURRENT_DATE,
  due_date          date NOT NULL,
  description       text NOT NULL,
  currency          char(3) NOT NULL DEFAULT 'EUR',
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),
  -- draft -> issued -> payment_pending -> paid ; issued/payment_pending -> cancelled.
  -- OVERDUE is derived (issued|payment_pending AND due_date past), never stored.
  status            text NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'issued', 'payment_pending', 'paid', 'cancelled')),
  payment_provider  text CHECK (payment_provider IN ('fire')),
  payment_reference text,
  fire_payment_code text,
  hosted_payment_url text,
  qr_generated_at   timestamptz,
  paid_at           timestamptz,
  paid_amount_cents bigint CHECK (paid_amount_cents >= 0),
  paid_currency     char(3),
  platform_snapshot jsonb,
  tenant_snapshot   jsonb,
  created_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

-- One subscription invoice per tenant per billing period — the renewal job is
-- idempotent because a re-run collides here. (adhoc invoices have a NULL
-- subscription_id / period_start, which never collide.)
CREATE UNIQUE INDEX platform_invoices_period_uk
  ON platform_invoices (tenant_id, subscription_id, period_start)
  WHERE subscription_id IS NOT NULL AND period_start IS NOT NULL;

CREATE UNIQUE INDEX platform_invoices_payment_reference_uk
  ON platform_invoices (payment_reference) WHERE payment_reference IS NOT NULL;
CREATE INDEX platform_invoices_tenant_idx ON platform_invoices (tenant_id, created_at DESC);
CREATE INDEX platform_invoices_status_idx ON platform_invoices (status, due_date);

-- ---------------------------------------------------------------------------
-- 5. platform_payments — the confirmed money-received ledger. One row per
--    invoice: the UNIQUE (invoice_id) makes applyConfirmedPayment idempotent.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id          uuid NOT NULL UNIQUE,
  tenant_id           uuid NOT NULL,
  provider            text NOT NULL DEFAULT 'fire',
  provider_payment_id text,
  amount_cents        bigint NOT NULL CHECK (amount_cents >= 0),
  currency            char(3) NOT NULL,
  confirmed_at        timestamptz NOT NULL DEFAULT now(),
  raw                 jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_payments_invoice_fk
    FOREIGN KEY (invoice_id, tenant_id)
    REFERENCES platform_invoices (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX platform_payments_tenant_idx ON platform_payments (tenant_id, confirmed_at DESC);

-- ---------------------------------------------------------------------------
-- 6. platform_payment_events — every inbound webhook + reconciliation result.
--    UNIQUE (provider, event_key) is the webhook duplicate guard.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_payment_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL DEFAULT 'fire',
  event_key          text NOT NULL,
  event_type         text,
  invoice_id         uuid REFERENCES platform_invoices (id) ON DELETE SET NULL,
  tenant_id          uuid REFERENCES tenants (id) ON DELETE SET NULL,
  signature_verified boolean NOT NULL DEFAULT false,
  payload            jsonb,
  processed_at       timestamptz,
  processing_error   text,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_key)
);

CREATE INDEX platform_payment_events_received_idx ON platform_payment_events (received_at DESC);

-- ---------------------------------------------------------------------------
-- 7. admin_notifications — the notification centre. Platform-admin only.
-- ---------------------------------------------------------------------------
CREATE TABLE admin_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text NOT NULL,
  tenant_id   uuid REFERENCES tenants (id) ON DELETE CASCADE,
  invoice_id  uuid REFERENCES platform_invoices (id) ON DELETE SET NULL,
  payment_id  uuid REFERENCES platform_payments (id) ON DELETE SET NULL,
  title       text NOT NULL,
  body        text,
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'attention')),
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX admin_notifications_dedupe_uk ON admin_notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX admin_notifications_unread_idx ON admin_notifications (created_at DESC)
  WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_plans TO invoice_app;
GRANT SELECT, INSERT, UPDATE          ON tenant_subscriptions, platform_invoices,
                                         platform_payments, platform_payment_events,
                                         admin_notifications TO invoice_app;
GRANT USAGE ON SEQUENCE platform_invoice_seq TO invoice_app;

-- ---------------------------------------------------------------------------
-- 9. Row-Level Security
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_plans        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscriptions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_payments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_payment_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_notifications       ENABLE ROW LEVEL SECURITY;

-- Plans: readable by any authenticated DB session (the catalogue); admin writes.
CREATE POLICY subscription_plans_read  ON subscription_plans FOR SELECT USING (true);
CREATE POLICY subscription_plans_admin ON subscription_plans FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

-- Subscription / invoices / payments: admin sees all; a tenant reads only its
-- own; only the admin (or trusted system context, which is admin-scoped) writes.
CREATE POLICY tenant_subscriptions_read ON tenant_subscriptions FOR SELECT
  USING (app_is_admin() OR tenant_id = app_current_tenant());
CREATE POLICY tenant_subscriptions_write ON tenant_subscriptions FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

CREATE POLICY platform_invoices_read ON platform_invoices FOR SELECT
  USING (app_is_admin() OR tenant_id = app_current_tenant());
CREATE POLICY platform_invoices_write ON platform_invoices FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

CREATE POLICY platform_payments_read ON platform_payments FOR SELECT
  USING (app_is_admin() OR tenant_id = app_current_tenant());
CREATE POLICY platform_payments_write ON platform_payments FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());

-- Event log + notification centre: platform admin only, in every direction.
CREATE POLICY platform_payment_events_admin ON platform_payment_events FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());
CREATE POLICY admin_notifications_admin ON admin_notifications FOR ALL
  USING (app_is_admin()) WITH CHECK (app_is_admin());
