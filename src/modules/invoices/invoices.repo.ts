import type { Queryable } from "../../db/types.ts";

export interface InvoiceRow {
  id: string;
  tenant_id: string;
  number: string;
  client_name: string;
  amount_cents: string; // bigint arrives as string
  currency: string;
  status: "draft" | "sent" | "paid" | "void";
  issued_on: string;
  due_on: string | null;
  created_by: string | null;
  created_at: string;
}

export interface NewInvoice {
  tenantId: string;
  number: string;
  clientName: string;
  amountCents: number;
  currency: string;
  status: InvoiceRow["status"];
  dueOn: string | null;
  createdBy: string;
}

const COLUMNS =
  "id, tenant_id, number, client_name, amount_cents, currency, status, issued_on, due_on, created_by, created_at";

export async function listInvoices(
  q: Queryable,
  opts: { tenantId?: string | null } = {},
): Promise<InvoiceRow[]> {
  if (opts.tenantId) {
    const { rows } = await q.query<InvoiceRow>(
      `SELECT ${COLUMNS} FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC, number DESC`,
      [opts.tenantId],
    );
    return rows;
  }
  const { rows } = await q.query<InvoiceRow>(
    `SELECT ${COLUMNS} FROM invoices ORDER BY created_at DESC, number DESC`,
  );
  return rows;
}

export async function getInvoiceById(q: Queryable, id: string): Promise<InvoiceRow | null> {
  const { rows } = await q.query<InvoiceRow>(
    `SELECT ${COLUMNS} FROM invoices WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function insertInvoice(q: Queryable, input: NewInvoice): Promise<InvoiceRow> {
  const { rows } = await q.query<InvoiceRow>(
    `INSERT INTO invoices
       (tenant_id, number, client_name, amount_cents, currency, status, due_on, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
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
  return rows[0]!;
}

export interface InvoicePatch {
  clientName?: string;
  amountCents?: number;
  status?: InvoiceRow["status"];
  dueOn?: string | null;
}

/**
 * Updates only the whitelisted mutable columns. `tenant_id`, `number`,
 * `created_by` and `id` are never writable here. Returns null when no row was
 * updated (not found, or hidden from the caller by RLS).
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
  if (patch.amountCents !== undefined) add("amount_cents", patch.amountCents);
  if (patch.status !== undefined) add("status", patch.status);
  if (patch.dueOn !== undefined) add("due_on", patch.dueOn);

  if (sets.length === 0) return getInvoiceById(q, id);

  params.push(id);
  const { rows } = await q.query<InvoiceRow>(
    `UPDATE invoices SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
}

/** Returns true when a row was actually deleted. */
export async function deleteInvoice(q: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await q.query(`DELETE FROM invoices WHERE id = $1`, [id]);
  return rowCount > 0;
}

export function serializeInvoice(row: InvoiceRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    number: row.number,
    clientName: row.client_name,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    status: row.status,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
