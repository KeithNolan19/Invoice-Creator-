import type { Queryable } from "../../db/types.ts";

export type InvoiceStatus = "draft" | "sent" | "paid" | "void";
export type PaymentStatus = "unpaid" | "pending" | "paid";

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  number: string;
  client_name: string;
  customer_id: string | null;
  customer_name: string | null;
  amount_cents: string; // bigint arrives as string
  total_cents: string | null;
  currency: string;
  status: InvoiceStatus;
  payment_status: PaymentStatus;
  issued_on: string;
  due_on: string | null;
  paid_at: string | Date | null;
  overdue: boolean;
  created_by: string | null;
  created_at: string;
}

export interface NewInvoice {
  tenantId: string;
  number: string;
  clientName: string;
  amountCents: number;
  currency: string;
  status: InvoiceStatus;
  dueOn: string | null;
  createdBy: string;
}

// Bare column list — safe for RETURNING (no table alias).
const RETURNING = "id";

// Full projection with the customer name and a computed `overdue` flag.
const SELECT_FULL = `
  SELECT i.id, i.tenant_id, i.number, i.client_name, i.customer_id,
         c.name AS customer_name,
         i.amount_cents, i.total_cents, i.currency, i.status, i.payment_status,
         i.issued_on, i.due_on, i.paid_at, i.created_by, i.created_at,
         (i.due_on IS NOT NULL AND i.due_on < current_date
            AND i.status NOT IN ('draft', 'void')
            AND i.payment_status IN ('unpaid', 'pending')) AS overdue
    FROM invoices i
    LEFT JOIN customers c ON c.id = i.customer_id
`;

export interface InvoiceListFilter {
  tenantId?: string | null;
  status?: InvoiceStatus;
  paymentStatus?: PaymentStatus;
  overdue?: boolean;
  customerId?: string;
  search?: string;
  limit?: number;
}

export async function listInvoices(
  q: Queryable,
  filter: InvoiceListFilter = {},
): Promise<InvoiceRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("$?", `$${params.length}`));
  };

  if (filter.tenantId) add("i.tenant_id = $?", filter.tenantId);
  if (filter.status) add("i.status = $?", filter.status);
  if (filter.paymentStatus) {
    add("i.payment_status = $?", filter.paymentStatus);
    // "Unpaid" / "Pending" are about *issued* invoices — a draft is neither.
    if (filter.paymentStatus !== "paid") where.push("i.status NOT IN ('draft','void')");
  }
  if (filter.customerId) add("i.customer_id = $?", filter.customerId);
  if (filter.overdue) {
    where.push(
      "i.due_on IS NOT NULL AND i.due_on < current_date AND i.status NOT IN ('draft','void') AND i.payment_status IN ('unpaid','pending')",
    );
  }
  if (filter.search) {
    params.push(`%${filter.search.trim()}%`);
    where.push(`(i.number ILIKE $${params.length} OR i.client_name ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ? `LIMIT ${Math.min(Math.max(filter.limit, 1), 500)}` : "";
  const { rows } = await q.query<InvoiceRow>(
    `${SELECT_FULL} ${clause} ORDER BY i.created_at DESC, i.number DESC ${limit}`,
    params,
  );
  return rows;
}

export async function getInvoiceById(q: Queryable, id: string): Promise<InvoiceRow | null> {
  const { rows } = await q.query<InvoiceRow>(`${SELECT_FULL} WHERE i.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function insertInvoice(q: Queryable, input: NewInvoice): Promise<InvoiceRow> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO invoices
       (tenant_id, number, client_name, amount_cents, subtotal_cents, total_cents, currency, status, due_on, created_by)
     VALUES ($1, $2, $3, $4, $4, $4, $5, $6, $7, $8)
     RETURNING ${RETURNING}`,
    [
      input.tenantId,
      input.number,
      input.clientName,
      input.amountCents,
      input.currency,
      input.status,
      input.dueOn,
      input.createdBy,
    ],
  );
  return (await getInvoiceById(q, rows[0]!.id))!;
}

export interface InvoicePatch {
  clientName?: string;
  amountCents?: number;
  status?: InvoiceStatus;
  dueOn?: string | null;
}

/**
 * Updates only the whitelisted mutable columns. `tenant_id`, `number`,
 * `created_by`, `payment_status` and `id` are never writable here. Returns null
 * when no row was updated (not found, or hidden from the caller by RLS).
 */
export async function updateInvoice(
  q: Queryable,
  id: string,
  patch: InvoicePatch,
): Promise<InvoiceRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown) => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };

  if (patch.clientName !== undefined) add("client_name", patch.clientName);
  if (patch.amountCents !== undefined) {
    add("amount_cents", patch.amountCents);
    add("total_cents", patch.amountCents);
  }
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.dueOn !== undefined) add("due_on", patch.dueOn);

  if (sets.length === 0) return getInvoiceById(q, id);

  params.push(id);
  const { rows } = await q.query<{ id: string }>(
    `UPDATE invoices SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id`,
    params,
  );
  if (!rows[0]) return null;
  return getInvoiceById(q, id);
}

/** Returns true when a row was actually deleted. */
export async function deleteInvoice(q: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await q.query(`DELETE FROM invoices WHERE id = $1`, [id]);
  return rowCount > 0;
}

export function serializeInvoice(row: InvoiceRow) {
  const total = row.total_cents != null ? Number(row.total_cents) : Number(row.amount_cents);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    number: row.number,
    customerId: row.customer_id,
    customerName: row.customer_name ?? row.client_name,
    clientName: row.client_name,
    amountCents: Number(row.amount_cents),
    totalCents: total,
    currency: row.currency,
    status: row.status,
    paymentStatus: row.payment_status,
    overdue: row.overdue === true,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    paidAt: row.paid_at ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
