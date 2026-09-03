-- Support chat + ticketing.
--
-- A tenant user opens a support ticket from the customer app; the platform
-- admin sees it in the Admin Control Centre, replies, and closes it. Delivery
-- is by polling (no websocket infrastructure) — see the routes.
--
-- Tenant-scoped and RLS-isolated exactly like the rest of the app: a tenant
-- sees only its own tickets and messages; the platform admin sees all.

CREATE TABLE support_tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  subject          text NOT NULL CHECK (length(btrim(subject)) > 0 AND length(subject) <= 200),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  closed_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  closed_at        timestamptz,
  tenant_last_read_at timestamptz,
  admin_last_read_at  timestamptz,
  last_message_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE INDEX support_tickets_tenant_idx ON support_tickets (tenant_id, last_message_at DESC);
CREATE INDEX support_tickets_status_idx ON support_tickets (status, last_message_at DESC);

CREATE TABLE support_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id      uuid NOT NULL,
  tenant_id      uuid NOT NULL,
  author_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  -- 'tenant' = a user of the ticket's tenant; 'admin' = the platform operator.
  author_kind    text NOT NULL CHECK (author_kind IN ('tenant', 'admin')),
  body           text NOT NULL CHECK (length(btrim(body)) > 0 AND length(body) <= 4000),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT support_messages_ticket_fk
    FOREIGN KEY (ticket_id, tenant_id)
    REFERENCES support_tickets (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at);
CREATE INDEX support_messages_tenant_idx ON support_messages (tenant_id);

GRANT SELECT, INSERT, UPDATE ON support_tickets  TO invoice_app;
GRANT SELECT, INSERT          ON support_messages TO invoice_app;

ALTER TABLE support_tickets  ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

-- Tickets: the platform admin sees all; a tenant sees only its own. A tenant
-- may open a ticket and update its own read marker; status changes (close /
-- reopen) are done only through the admin routes.
CREATE POLICY support_tickets_isolation ON support_tickets
  FOR ALL
  USING (app_is_admin() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_admin() OR tenant_id = app_current_tenant());

-- Messages: same visibility. Append-only (no UPDATE/DELETE policy or grant).
CREATE POLICY support_messages_isolation ON support_messages
  FOR ALL
  USING (app_is_admin() OR tenant_id = app_current_tenant())
  WITH CHECK (app_is_admin() OR tenant_id = app_current_tenant());
