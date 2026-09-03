-- Core schema: tenants, users, and the first tenant-owned resource (invoices).
-- gen_random_uuid() is in core Postgres since v13; no extension required.

CREATE TYPE user_role AS ENUM ('user', 'admin');

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          user_role NOT NULL DEFAULT 'user',
  -- Regular users belong to exactly one tenant. Platform admins are global
  -- (tenant_id IS NULL) and can see across tenants.
  tenant_id     uuid REFERENCES tenants (id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_tenant_matches_role CHECK (
    (role = 'admin'  AND tenant_id IS NULL) OR
    (role = 'user'   AND tenant_id IS NOT NULL)
  )
);

CREATE INDEX users_tenant_id_idx ON users (tenant_id);

-- CITEXT would be nicer for email; keep to core types and normalise in the app.
CREATE TABLE invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number       text NOT NULL,
  client_name  text NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'sent', 'paid', 'void')),
  issued_on    date NOT NULL DEFAULT CURRENT_DATE,
  due_on       date,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);

CREATE INDEX invoices_tenant_id_idx ON invoices (tenant_id);
