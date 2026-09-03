import type { Db, Queryable } from "../db/types.ts";
import { withSystemContext } from "../db/system-context.ts";
import { recordAudit } from "../modules/admin/audit.ts";
import { createNotification } from "../modules/billing/notifications.repo.ts";
import {
  getPlatformInvoice,
  setPlatformInvoiceStatus,
} from "../modules/billing/platform-invoices.repo.ts";
import { advanceSubscriptionPeriod } from "../modules/billing/subscriptions.repo.ts";
import { accountState } from "./state.ts";
import { nextPeriodStart, periodEnd } from "./pricing.ts";

export type ApplyPaymentOutcome = "applied" | "already_applied" | "invoice_not_found" | "amount_mismatch";

export interface ConfirmedPayment {
  invoiceId: string;
  amountCents: number;
  currency: string;
  providerPaymentId?: string | null;
  raw?: unknown;
  source: "webhook" | "reconciliation" | "manual";
}

/**
 * The ONE place an invoice becomes paid. Idempotent (the UNIQUE on
 * platform_payments.invoice_id absorbs duplicates from webhook + poll racing).
 * Runs in a single system-context transaction.
 *
 * On confirmed payment it also: records the payment, marks the invoice paid,
 * rolls the subscription period forward, auto-reactivates a SUSPENDED_UNPAID
 * tenant, and raises the admin notifications.
 */
export async function applyConfirmedPayment(db: Db, p: ConfirmedPayment): Promise<ApplyPaymentOutcome> {
  return withSystemContext(db, (q) => applyIn(q, p));
}

async function applyIn(q: Queryable, p: ConfirmedPayment): Promise<ApplyPaymentOutcome> {
  const inv = await getPlatformInvoice(q, p.invoiceId);
  if (!inv) return "invoice_not_found";
  if (inv.status === "paid") return "already_applied";

  if (p.amountCents + 0 < Number(inv.amount_cents)) {
    await createNotification(q, {
      type: "payment_requires_attention",
      tenantId: inv.tenant_id,
      invoiceId: inv.id,
      title: `Underpayment on ${inv.number}`,
      body: `Expected ${inv.currency} ${(Number(inv.amount_cents) / 100).toFixed(2)}, received ${(p.amountCents / 100).toFixed(2)}`,
      severity: "attention",
      dedupeKey: `underpaid:${inv.id}`,
    });
    return "amount_mismatch";
  }

  const ins = await q.query<{ id: string }>(
    `INSERT INTO platform_payments (invoice_id, tenant_id, provider, provider_payment_id, amount_cents, currency, raw)
     VALUES ($1, $2, 'fire', $3, $4, $5, $6::jsonb)
     ON CONFLICT (invoice_id) DO NOTHING
     RETURNING id`,
    [inv.id, inv.tenant_id, p.providerPaymentId ?? null, p.amountCents, p.currency, JSON.stringify(p.raw ?? {})],
  );
  if (!ins.rows[0]) return "already_applied"; // raced — another path applied it
  const paymentId = ins.rows[0].id;

  const target = inv.status === "payment_pending" || inv.status === "issued" ? "paid" : null;
  if (!target) return "already_applied";
  await setPlatformInvoiceStatus(q, inv.id, "paid", {
    paidAt: new Date().toISOString(),
    paidAmountCents: p.amountCents,
    paidCurrency: p.currency,
  });

  // Roll the subscription period forward for a renewal invoice.
  if (inv.subscription_id && inv.period_end) {
    const subRows = await q.query<{ billing_interval: "day" | "month" | "year" }>(
      "SELECT billing_interval FROM tenant_subscriptions WHERE id = $1",
      [inv.subscription_id],
    );
    const bi = subRows.rows[0]?.billing_interval;
    if (bi) {
      const nextStart = addDaysUTC(inv.period_end, 1);
      await advanceSubscriptionPeriod(q, inv.subscription_id, {
        periodStart: iso(nextStart),
        periodEnd: iso(periodEnd(nextStart, bi)),
        renewalDate: iso(nextPeriodStart(nextStart, bi)),
      });
    }
  }

  // Auto-reactivate only a tenant suspended for non-payment.
  const tRows = await q.query<{ name: string; status: "active" | "suspended"; suspension_reason: "unpaid" | "other" | null }>(
    "SELECT name, status, suspension_reason FROM tenants WHERE id = $1",
    [inv.tenant_id],
  );
  const tenant = tRows.rows[0];
  if (tenant && accountState(tenant) === "SUSPENDED_UNPAID") {
    await q.query(
      `UPDATE tenants SET status = 'active', reactivated_at = now(),
             reactivation_note = $2, suspension_reason = NULL WHERE id = $1`,
      [inv.tenant_id, `auto: ${inv.number} paid`],
    );
    await recordAudit(q, {
      actorUserId: null,
      action: "tenant.reactivated",
      tenantId: inv.tenant_id,
      metadata: { source: "system", auto: true, invoice: inv.number },
    });
    await createNotification(q, {
      type: "account_reactivated_auto",
      tenantId: inv.tenant_id,
      invoiceId: inv.id,
      paymentId,
      title: `${tenant.name} paid — account reactivated`,
      body: `Invoice ${inv.number} settled; the account is active again.`,
      severity: "attention",
    });
  }

  await createNotification(q, {
    type: "client_paid",
    tenantId: inv.tenant_id,
    invoiceId: inv.id,
    paymentId,
    title: `${tenant?.name ?? "A client"} paid ${inv.number}`,
    body: `${p.currency} ${(p.amountCents / 100).toFixed(2)} — via ${p.source}`,
    severity: "info",
  });
  await recordAudit(q, {
    actorUserId: null,
    action: "billing.invoice_paid",
    tenantId: inv.tenant_id,
    metadata: { source: p.source, invoice: inv.number, amountCents: p.amountCents, paymentId },
  });

  return "applied";
}

function addDaysUTC(dateStr: string, days: number): Date {
  const d = new Date(dateStr + (dateStr.length === 10 ? "T00:00:00Z" : ""));
  d.setUTCDate(d.getUTCDate() + days);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
