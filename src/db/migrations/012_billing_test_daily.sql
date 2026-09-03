-- Platform billing — a daily test plan + the scheduler's supporting columns.
--
-- The €1/day plan renews every 24h so the full renewal → invoice → pay →
-- confirm → renew loop can be exercised in minutes instead of a month. It is
-- flagged is_test = true; production dashboards can hide test tenants.
--
-- Also generalises the plan interval (day | month) and adds a per-plan reminder
-- lead time (how long before renewal the client is notified / the invoice is
-- generated).

-- ---------------------------------------------------------------------------
-- 1. subscription_plans: interval + a real "base amount" + reminder lead
-- ---------------------------------------------------------------------------
ALTER TABLE subscription_plans
  ADD COLUMN base_interval text NOT NULL DEFAULT 'month' CHECK (base_interval IN ('day', 'month')),
  ADD COLUMN base_amount_cents bigint,
  ADD COLUMN reminder_lead_minutes integer NOT NULL DEFAULT 10080  -- 7 days
    CHECK (reminder_lead_minutes >= 0),
  ADD COLUMN is_test boolean NOT NULL DEFAULT false;

UPDATE subscription_plans SET base_amount_cents = monthly_cents WHERE base_amount_cents IS NULL;
ALTER TABLE subscription_plans ALTER COLUMN base_amount_cents SET NOT NULL;
ALTER TABLE subscription_plans ADD CONSTRAINT subscription_plans_base_amount_ck CHECK (base_amount_cents >= 0);

-- `monthly_cents` is now redundant (base_amount_cents + base_interval replace it).
-- Safe to drop: only the 3 seeded rows exist and nothing references it.
ALTER TABLE subscription_plans DROP COLUMN monthly_cents;

INSERT INTO subscription_plans
  (code, name, max_users, base_interval, base_amount_cents, currency, sort_order, active, reminder_lead_minutes, is_test)
VALUES
  ('test-daily', 'Test (daily)', 5, 'day', 100, 'EUR', 99, true, 60, true)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. tenant_subscriptions: allow the 'day' cadence
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_subscriptions DROP CONSTRAINT tenant_subscriptions_billing_interval_check;
ALTER TABLE tenant_subscriptions ADD CONSTRAINT tenant_subscriptions_billing_interval_check
  CHECK (billing_interval IN ('day', 'month', 'year'));

-- ---------------------------------------------------------------------------
-- 3. tenant_subscriptions: track the last period we generated a renewal for,
--    so the scheduler is idempotent even before the invoice row exists.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_subscriptions
  ADD COLUMN last_renewal_generated_for date;

-- ---------------------------------------------------------------------------
-- 4. platform_billing_config: a switch to run the scheduler faster in test
-- ---------------------------------------------------------------------------
ALTER TABLE platform_billing_config
  ADD COLUMN scheduler_enabled boolean NOT NULL DEFAULT true;
