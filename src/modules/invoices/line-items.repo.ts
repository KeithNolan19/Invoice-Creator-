import type { Queryable } from "../../db/types.ts";

export interface LineItemRow {
  id: string;
  invoice_id: string;
  tenant_id: string;
  position: number;
  description: string;
  quantity: string; // numeric arrives as string
  unit_price_cents: string; // bigint arrives as string
  tax_rate: string;
  discount_cents: string;
  line_total_cents: string;
  created_at: string;
}

export interface LineItemInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRate?: number;
  discountCents?: number;
  lineTotalCents: number;
}

const COLUMNS =
  "id, invoice_id, tenant_id, position, description, quantity, unit_price_cents, tax_rate, discount_cents, line_total_cents, created_at";

export async function listLineItems(q: Queryable, invoiceId: string): Promise<LineItemRow[]> {
  const { rows } = await q.query<LineItemRow>(
    `SELECT ${COLUMNS} FROM invoice_line_items WHERE invoice_id = $1 ORDER BY position ASC`,
    [invoiceId],
  );
  return rows;
}

/**
 * Replaces an invoice's line items wholesale (used by draft save / edit).
 * `tenantId` is the invoice's tenant — the composite FK to `invoices (id,
 * tenant_id)` rejects any attempt to write it under a different tenant, and RLS
 * rejects writing under a tenant that is not the caller's.
 */
export async function replaceLineItems(
  q: Queryable,
  invoiceId: string,
  tenantId: string,
  items: LineItemInput[],
): Promise<LineItemRow[]> {
  await q.query("DELETE FROM invoice_line_items WHERE invoice_id = $1", [invoiceId]);
  const out: LineItemRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const { rows } = await q.query<LineItemRow>(
      `INSERT INTO invoice_line_items
         (invoice_id, tenant_id, position, description, quantity, unit_price_cents,
          tax_rate, discount_cents, line_total_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
      [
        invoiceId,
        tenantId,
        i,
        it.description.trim(),
        it.quantity,
        it.unitPriceCents,
        it.taxRate ?? 0,
        it.discountCents ?? 0,
        it.lineTotalCents,
      ],
    );
    out.push(rows[0]!);
  }
  return out;
}

export function serializeLineItem(row: LineItemRow) {
  return {
    id: row.id,
    position: row.position,
    description: row.description,
    quantity: Number(row.quantity),
    unitPriceCents: Number(row.unit_price_cents),
    taxRate: Number(row.tax_rate),
    discountCents: Number(row.discount_cents),
    lineTotalCents: Number(row.line_total_cents),
  };
}
