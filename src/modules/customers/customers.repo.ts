import type { Queryable } from "../../db/types.ts";

export interface CustomerRow {
  id: string;
  tenant_id: string;
  name: string;
  email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  tax_number: string | null;
  notes: string | null;
  archived_at: string | Date | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerInput {
  name: string;
  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  notes?: string | null;
}

const COLUMNS =
  "id, tenant_id, name, email, address_line1, address_line2, city, region, postal_code, country, tax_number, notes, archived_at, created_by, created_at, updated_at";
const COLUMNS_C = COLUMNS.split(", ").map((c) => `c.${c}`).join(", ");

export interface CustomerListRow extends CustomerRow {
  invoice_count: number;
}

/** RLS scopes every query below to the caller's tenant. */
export async function listCustomers(
  q: Queryable,
  opts: { includeArchived?: boolean; search?: string } = {},
): Promise<CustomerListRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeArchived) where.push("c.archived_at IS NULL");
  if (opts.search) {
    params.push(`%${opts.search.trim()}%`);
    where.push(`(c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const { rows } = await q.query<CustomerListRow>(
    `SELECT ${COLUMNS_C},
            (SELECT count(*) FROM invoices i WHERE i.customer_id = c.id)::int AS invoice_count
       FROM customers c ${clause}
      ORDER BY lower(c.name) ASC`,
    params,
  );
  return rows;
}

export async function getCustomerById(q: Queryable, id: string): Promise<CustomerRow | null> {
  const { rows } = await q.query<CustomerRow>(`SELECT ${COLUMNS} FROM customers WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertCustomer(
  q: Queryable,
  tenantId: string,
  createdBy: string | null,
  input: CustomerInput,
): Promise<CustomerRow> {
  const { rows } = await q.query<CustomerRow>(
    `INSERT INTO customers
       (tenant_id, created_by, name, email, address_line1, address_line2, city, region,
        postal_code, country, tax_number, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${COLUMNS}`,
    [
      tenantId,
      createdBy,
      input.name.trim(),
      norm(input.email),
      input.addressLine1 ?? null,
      input.addressLine2 ?? null,
      input.city ?? null,
      input.region ?? null,
      input.postalCode ?? null,
      input.country ?? null,
      input.taxNumber ?? null,
      input.notes ?? null,
    ],
  );
  return rows[0]!;
}

export async function updateCustomer(
  q: Queryable,
  id: string,
  patch: Partial<CustomerInput>,
): Promise<CustomerRow | null> {
  const map: Record<string, string> = {
    name: "name",
    email: "email",
    addressLine1: "address_line1",
    addressLine2: "address_line2",
    city: "city",
    region: "region",
    postalCode: "postal_code",
    country: "country",
    taxNumber: "tax_number",
    notes: "notes",
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, col] of Object.entries(map)) {
    if (key in patch) {
      const value = (patch as Record<string, unknown>)[key];
      params.push(key === "email" ? norm(value as string | null | undefined) : (value ?? null));
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) return getCustomerById(q, id);
  sets.push("updated_at = now()");
  params.push(id);
  const { rows } = await q.query<CustomerRow>(
    `UPDATE customers SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
}

export async function archiveCustomer(q: Queryable, id: string): Promise<CustomerRow | null> {
  const { rows } = await q.query<CustomerRow>(
    `UPDATE customers SET archived_at = now(), updated_at = now()
     WHERE id = $1 AND archived_at IS NULL RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0] ?? null;
}

function norm(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().toLowerCase();
  return t === "" ? null : t;
}

export function serializeCustomer(row: CustomerRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    email: row.email,
    address: {
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      region: row.region,
      postalCode: row.postal_code,
      country: row.country,
    },
    taxNumber: row.tax_number,
    notes: row.notes,
    archived: row.archived_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeCustomerListItem(row: CustomerListRow) {
  return { ...serializeCustomer(row), invoiceCount: row.invoice_count };
}

export interface CustomerInvoiceStats {
  invoice_count: number;
  total_cents: string;
  paid_cents: string;
  outstanding_cents: string;
}

/** Aggregate invoice figures for one customer (RLS-scoped). */
export async function getCustomerInvoiceStats(
  q: Queryable,
  customerId: string,
): Promise<CustomerInvoiceStats> {
  const { rows } = await q.query<CustomerInvoiceStats>(
    `SELECT count(*)::int AS invoice_count,
            coalesce(sum(total_cents), 0) AS total_cents,
            coalesce(sum(total_cents) FILTER (WHERE payment_status = 'paid'), 0) AS paid_cents,
            coalesce(sum(total_cents) FILTER (
              WHERE payment_status IN ('unpaid','pending') AND status NOT IN ('draft','void')
            ), 0) AS outstanding_cents
       FROM invoices WHERE customer_id = $1`,
    [customerId],
  );
  return rows[0]!;
}

export function serializeCustomerStats(s: CustomerInvoiceStats) {
  return {
    invoiceCount: s.invoice_count,
    totalCents: Number(s.total_cents),
    paidCents: Number(s.paid_cents),
    outstandingCents: Number(s.outstanding_cents),
  };
}
