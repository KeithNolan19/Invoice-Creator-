import type { Queryable } from "../../db/types.ts";
import { assertInvoiceTransition, type InvoiceState, isInvoiceOverdue } from "../../billing/state.ts";

export interface PlatformInvoiceRow {
  id: string;
  tenant_id: string;
  tenant_name: string | null;
  number: string;
  subscription_id: string | null;
  kind: "subscription" | "adhoc";
  period_start: string | null;
  period_end: string | null;
  issue_date: string;
  due_date: string;
  description: string;
  currency: string;
  amount_cents: string;
  status: InvoiceState;
  payment_provider: string | null;
  payment_reference: string | null;
  fire_payment_code: string | null;
  hosted_payment_url: string | null;
  paid_at: string | null;
  paid_amount_cents: string | null;
  paid_currency: string | null;
  created_at: string;
}

const SELECT = `
  SELECT i.id, i.tenant_id, t.name AS tenant_name, i.number, i.subscription_id, i.kind,
         i.period_start::text AS period_start, i.period_end::text AS period_end, i.issue_date::text AS issue_date, i.due_date::text AS due_date, i.description, i.currency,
         i.amount_cents, i.status, i.payment_provider, i.payment_reference, i.fire_payment_code,
         i.hosted_payment_url, i.paid_at, i.paid_amount_cents, i.paid_currency, i.created_at
    FROM platform_invoices i
    JOIN tenants t ON t.id = i.tenant_id
`;

/** Allocate the next platform invoice number, e.g. "VD-000001". */
export async function allocatePlatformInvoiceNumber(q: Queryable): Promise<string> {
  const { rows } = await q.query<{ n: string; prefix: string }>(
    `SELECT nextval('platform_invoice_seq') AS n,
            (SELECT invoice_number_prefix FROM platform_billing_config WHERE id = 1) AS prefix`,
  );
  const n = Number(rows[0]!.n);
  return `${rows[0]!.prefix ?? "VD-"}${String(n).padStart(6, "0")}`;
}

export interface NewPlatformInvoice {
  tenantId: string;
  number: string;
  subscriptionId?: string | null;
  kind?: "subscription" | "adhoc";
  periodStart?: string | null;
  periodEnd?: string | null;
  dueDate: string;
  description: string;
  currency: string;
  amountCents: number;
  createdBy?: string | null;
}

/** Inserts a DRAFT invoice. Returns null if the period unique index rejects it (idempotency). */
export async function insertPlatformInvoice(
  q: Queryable,
  input: NewPlatformInvoice,
): Promise<PlatformInvoiceRow | null> {
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO platform_invoices
       (tenant_id, number, subscription_id, kind, period_start, period_end,
        due_date, description, currency, amount_cents, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id, subscription_id, period_start)
       WHERE subscription_id IS NOT NULL AND period_start IS NOT NULL
       DO NOTHING
     RETURNING id`,
    [
      input.tenantId,
      input.number,
      input.subscriptionId ?? null,
      input.kind ?? "subscription",
      input.periodStart ?? null,
      input.periodEnd ?? null,
      input.dueDate,
      input.description,
      input.currency,
      input.amountCents,
      input.createdBy ?? null,
    ],
  );
  if (!rows[0]) return null;
  return getPlatformInvoice(q, rows[0].id);
}

export async function getPlatformInvoice(q: Queryable, id: string): Promise<PlatformInvoiceRow | null> {
  const { rows } = await q.query<PlatformInvoiceRow>(`${SELECT} WHERE i.id = $1`, [id]);
  return rows[0] ?? null;
}

export interface PlatformInvoiceFilter {
  tenantId?: string;
  status?: InvoiceState;
  unpaidOnly?: boolean;
  limit?: number;
}

export async function listPlatformInvoices(
  q: Queryable,
  filter: PlatformInvoiceFilter = {},
): Promise<PlatformInvoiceRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.tenantId) {
    params.push(filter.tenantId);
    where.push(`i.tenant_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    where.push(`i.status = $${params.length}`);
  }
  if (filter.unpaidOnly) where.push(`i.status IN ('issued','payment_pending')`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit ? `LIMIT ${Math.min(Math.max(filter.limit, 1), 500)}` : "";
  const { rows } = await q.query<PlatformInvoiceRow>(
    `${SELECT} ${clause} ORDER BY i.created_at DESC ${limit}`,
    params,
  );
  return rows;
}

export interface InvoiceStatusPatch {
  paymentProvider?: "fire";
  paymentReference?: string;
  firePaymentCode?: string;
  hostedPaymentUrl?: string;
  qrGeneratedAt?: string;
  paidAt?: string;
  paidAmountCents?: number;
  paidCurrency?: string;
  platformSnapshot?: unknown;
  tenantSnapshot?: unknown;
}

/** Moves an invoice to `to`, validating the transition. Extra columns via `patch`. */
export async function setPlatformInvoiceStatus(
  q: Queryable,
  id: string,
  to: InvoiceState,
  patch: InvoiceStatusPatch = {},
): Promise<PlatformInvoiceRow | null> {
  const current = await getPlatformInvoice(q, id);
  if (!current) return null;
  assertInvoiceTransition(current.status, to);

  const sets = ["status = $2", "updated_at = now()"];
  const params: unknown[] = [id, to];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.paymentProvider !== undefined) add("payment_provider", patch.paymentProvider);
  if (patch.paymentReference !== undefined) add("payment_reference", patch.paymentReference);
  if (patch.firePaymentCode !== undefined) add("fire_payment_code", patch.firePaymentCode);
  if (patch.hostedPaymentUrl !== undefined) add("hosted_payment_url", patch.hostedPaymentUrl);
  if (patch.qrGeneratedAt !== undefined) add("qr_generated_at", patch.qrGeneratedAt);
  if (patch.paidAt !== undefined) add("paid_at", patch.paidAt);
  if (patch.paidAmountCents !== undefined) add("paid_amount_cents", patch.paidAmountCents);
  if (patch.paidCurrency !== undefined) add("paid_currency", patch.paidCurrency);
  if (patch.platformSnapshot !== undefined) add("platform_snapshot", JSON.stringify(patch.platformSnapshot));
  if (patch.tenantSnapshot !== undefined) add("tenant_snapshot", JSON.stringify(patch.tenantSnapshot));

  await q.query(`UPDATE platform_invoices SET ${sets.join(", ")} WHERE id = $1`, params);
  return getPlatformInvoice(q, id);
}

export function serializePlatformInvoice(i: PlatformInvoiceRow, graceDays = 0) {
  return {
    id: i.id,
    tenantId: i.tenant_id,
    tenantName: i.tenant_name,
    number: i.number,
    kind: i.kind,
    periodStart: i.period_start,
    periodEnd: i.period_end,
    issueDate: i.issue_date,
    dueDate: i.due_date,
    description: i.description,
    currency: i.currency,
    amountCents: Number(i.amount_cents),
    status: i.status,
    overdue: isInvoiceOverdue(i, graceDays),
    paymentReference: i.payment_reference,
    firePaymentCode: i.fire_payment_code,
    hostedPaymentUrl: i.hosted_payment_url,
    paidAt: i.paid_at,
    paidAmountCents: i.paid_amount_cents != null ? Number(i.paid_amount_cents) : null,
    createdAt: i.created_at,
  };
}
