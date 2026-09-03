import type { Queryable } from "../../db/types.ts";

/**
 * Read-only data browser for the Admin Control Centre. Every query is run in an
 * admin RLS context and explicitly scoped by tenant id, so it's a deliberate
 * cross-tenant read — the platform owner looking at what their customers have
 * built. No writes, ever.
 */

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  users: number;
  customers: number;
  invoices: number;
  open_tickets: number;
  plan: string | null;
}

export async function getDataOverview(q: Queryable): Promise<{
  tenants: TenantSummary[];
  totals: Record<string, number>;
}> {
  const { rows: tenants } = await q.query<TenantSummary>(`
    SELECT t.id, t.name, t.slug, t.status, t.created_at::text AS created_at,
           (SELECT count(*) FROM users u          WHERE u.tenant_id = t.id)::int AS users,
           (SELECT count(*) FROM customers c      WHERE c.tenant_id = t.id)::int AS customers,
           (SELECT count(*) FROM invoices i       WHERE i.tenant_id = t.id)::int AS invoices,
           (SELECT count(*) FROM support_tickets s WHERE s.tenant_id = t.id AND s.status = 'open')::int AS open_tickets,
           (SELECT p.name FROM tenant_subscriptions sub JOIN subscription_plans p ON p.id = sub.plan_id
             WHERE sub.tenant_id = t.id) AS plan
      FROM tenants t
     ORDER BY t.name
  `);

  const { rows: totalRows } = await q.query<Record<string, string>>(`
    SELECT
      (SELECT count(*) FROM tenants)::text            AS tenants,
      (SELECT count(*) FROM users)::text              AS users,
      (SELECT count(*) FROM customers)::text          AS customers,
      (SELECT count(*) FROM invoices)::text           AS invoices,
      (SELECT count(*) FROM invoice_line_items)::text AS line_items,
      (SELECT count(*) FROM support_tickets)::text    AS tickets,
      (SELECT count(*) FROM platform_invoices)::text  AS platform_invoices,
      (SELECT count(*) FROM platform_payments)::text  AS platform_payments
  `);
  const totals = Object.fromEntries(
    Object.entries(totalRows[0] ?? {}).map(([k, v]) => [k, Number(v)]),
  );
  return { tenants, totals };
}

export interface TenantDataBundle {
  tenant: Record<string, unknown> | null;
  settings: Record<string, unknown> | null;
  subscription: Record<string, unknown> | null;
  users: Record<string, unknown>[];
  customers: Record<string, unknown>[];
  invoices: Record<string, unknown>[];
  tickets: Record<string, unknown>[];
}

export async function getTenantData(q: Queryable, tenantId: string): Promise<TenantDataBundle> {
  const one = async (sql: string) => (await q.query(sql, [tenantId])).rows[0] ?? null;
  const many = async (sql: string) => (await q.query(sql, [tenantId])).rows as Record<string, unknown>[];

  const tenant = await one(
    `SELECT id, name, slug, status, suspension_reason, suspended_at::text AS suspended_at,
            reactivated_at::text AS reactivated_at, created_at::text AS created_at
       FROM tenants WHERE id = $1`,
  );
  if (!tenant) return { tenant: null, settings: null, subscription: null, users: [], customers: [], invoices: [], tickets: [] };

  const settings = await one(
    `SELECT business_name, contact_email, contact_phone, address_line1, address_line2,
            city, region, postal_code, country, tax_number, tax_scheme,
            default_currency, default_due_days, invoice_number_prefix,
            default_notes, default_payment_terms
       FROM tenant_settings WHERE tenant_id = $1`,
  );

  const subscription = await one(
    `SELECT p.name AS plan, p.code AS plan_code, sub.billing_interval, sub.amount_cents,
            sub.currency, sub.status,
            sub.current_period_start::text AS current_period_start,
            sub.current_period_end::text   AS current_period_end,
            sub.renewal_date::text         AS renewal_date
       FROM tenant_subscriptions sub JOIN subscription_plans p ON p.id = sub.plan_id
      WHERE sub.tenant_id = $1`,
  );

  const users = await many(
    `SELECT email, name, role, tenant_role,
            disabled_at::text AS disabled_at,
            last_login_at::text AS last_login_at,
            last_seen_at::text AS last_seen_at,
            created_at::text AS created_at
       FROM users WHERE tenant_id = $1 ORDER BY created_at`,
  );

  const customers = await many(
    `SELECT c.name, c.email, c.address_line1, c.address_line2, c.city, c.region,
            c.postal_code, c.country, c.tax_number, c.notes,
            c.archived_at::text AS archived_at, c.created_at::text AS created_at,
            (SELECT count(*) FROM invoices i WHERE i.customer_id = c.id)::int AS invoice_count
       FROM customers c WHERE c.tenant_id = $1 ORDER BY lower(c.name)`,
  );

  const invoiceRows = await many(
    `SELECT i.id, i.number, i.client_name, cu.name AS customer_name,
            i.amount_cents, i.total_cents, i.currency, i.status, i.payment_status,
            i.issued_on::text AS issued_on, i.due_on::text AS due_on,
            i.paid_at::text AS paid_at, i.created_at::text AS created_at
       FROM invoices i LEFT JOIN customers cu ON cu.id = i.customer_id
      WHERE i.tenant_id = $1 ORDER BY i.created_at DESC`,
  );
  const invoices = await Promise.all(
    invoiceRows.map(async (inv) => {
      const { rows: lineItems } = await q.query(
        `SELECT position, description, quantity, unit_price_cents, tax_rate,
                discount_cents, line_total_cents
           FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position`,
        [inv.id],
      );
      return { ...inv, lineItems };
    }),
  );

  const ticketRows = await many(
    `SELECT s.id, s.subject, s.status, s.created_at::text AS created_at,
            s.last_message_at::text AS last_message_at,
            u.email AS opened_by_email
       FROM support_tickets s LEFT JOIN users u ON u.id = s.opened_by
      WHERE s.tenant_id = $1 ORDER BY s.last_message_at DESC`,
  );
  const tickets = await Promise.all(
    ticketRows.map(async (t) => {
      const { rows: messages } = await q.query(
        `SELECT m.author_kind, m.body, m.created_at::text AS created_at, u.email AS author_email
           FROM support_messages m LEFT JOIN users u ON u.id = m.author_user_id
          WHERE m.ticket_id = $1 ORDER BY m.created_at`,
        [t.id],
      );
      return { ...t, messages };
    }),
  );

  return { tenant, settings, subscription, users, customers, invoices, tickets };
}
