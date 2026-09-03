import { config } from "../config.ts";
import type { Db, Queryable } from "../db/types.ts";
import { withSystemContext } from "../db/system-context.ts";
import { FireClient } from "../integrations/fire/index.ts";
import { recordAudit } from "../modules/admin/audit.ts";
import { getBillingConfigSafe, getFireAuthCredentials } from "../modules/billing/billing-config.repo.ts";
import { createNotification } from "../modules/billing/notifications.repo.ts";
import {
  allocatePlatformInvoiceNumber,
  insertPlatformInvoice,
  listPlatformInvoices,
  setPlatformInvoiceStatus,
} from "../modules/billing/platform-invoices.repo.ts";
import { listActiveSubscriptions, markRenewalGenerated } from "../modules/billing/subscriptions.repo.ts";
import { applyConfirmedPayment } from "./apply-payment.ts";
import { isInvoiceOverdue } from "./state.ts";
import { periodEnd } from "./pricing.ts";

export interface TickResult {
  skipped?: string;
  renewalsGenerated: number;
  overdueFlagged: number;
  reconciled: number;
  errors: string[];
}

/**
 * One pass of the time-based billing work. Idempotent and safe to run again:
 *   - only one runs at a time (advisory lock)
 *   - a renewal invoice can't be generated twice (per-period unique index +
 *     the subscription's last_renewal_generated_for marker)
 *   - a payment can't be applied twice (platform_payments.invoice_id unique)
 *
 * Run hourly by a systemd timer (deploy/invoice-billing.timer).
 */
export async function runBillingTick(db: Db, now: Date = new Date()): Promise<TickResult> {
  return withSystemContext(db, (q) => tick(db, q, now));
}

async function tick(db: Db, q: Queryable, now: Date): Promise<TickResult> {
  const result: TickResult = { renewalsGenerated: 0, overdueFlagged: 0, reconciled: 0, errors: [] };

  // Serialise ticks. If another holds the lock, bail cheaply.
  const lock = await q.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('billing-tick')) AS locked");
  if (!lock.rows[0]?.locked) return { ...result, skipped: "another tick is running" };

  const cfg = await getBillingConfigSafe(q);
  if (!cfg.schedulerEnabled) return { ...result, skipped: "scheduler disabled" };

  const authCreds = await getFireAuthCredentials(q);
  const fire = authCreds ? new FireClient(authCreds) : null;

  // ---- 1. Renewal invoice generation -------------------------------------
  for (const s of await listActiveSubscriptions(q)) {
    try {
      const renewalDate = new Date(`${s.renewal_date}T00:00:00Z`);
      const leadMs = s.plan_reminder_lead_minutes * 60_000;
      const withinLead = now.getTime() >= renewalDate.getTime() - leadMs;
      if (!withinLead || s.last_renewal_generated_for === s.renewal_date) continue;

      const pStart = renewalDate;
      const pEnd = periodEnd(pStart, s.billing_interval);
      const number = await allocatePlatformInvoiceNumber(q);
      const inv = await insertPlatformInvoice(q, {
        tenantId: s.tenant_id,
        number,
        subscriptionId: s.id,
        kind: "subscription",
        periodStart: iso(pStart),
        periodEnd: iso(pEnd),
        dueDate: s.renewal_date,
        description: `${s.plan_name} — ${iso(pStart)}`,
        currency: s.currency,
        amountCents: Number(s.amount_cents),
      });
      await markRenewalGenerated(q, s.id, s.renewal_date);
      if (!inv) continue; // already existed (idempotent)

      await setPlatformInvoiceStatus(q, inv.id, "issued");

      // Create the Fire payment request so the client has a pay link + QR.
      if (fire && cfg.fireCollectionIcan) {
        try {
          const created = await fire.createPaymentRequest({
            amountMinor: Number(s.amount_cents),
            currency: (s.currency as "EUR" | "GBP") ?? "EUR",
            myRef: number,
            description: number.slice(0, 18),
            icanTo: Number(cfg.fireCollectionIcan),
          });
          await setPlatformInvoiceStatus(q, inv.id, "payment_pending", {
            paymentProvider: "fire",
            paymentReference: number,
            firePaymentCode: created.code,
            hostedPaymentUrl: `${config.fire.paymentsBaseUrl}/${created.code}`,
            qrGeneratedAt: new Date().toISOString(),
          });
        } catch (err) {
          result.errors.push(`fire payment request for ${number}: ${(err as Error).message}`);
          await createNotification(q, {
            type: "provider_error",
            tenantId: s.tenant_id,
            invoiceId: inv.id,
            title: `Fire.com error preparing ${number}`,
            body: (err as Error).message,
            severity: "attention",
            dedupeKey: `provider_err:${number}`,
          });
        }
      }

      await createNotification(q, {
        type: "renewal_invoice_generated",
        tenantId: s.tenant_id,
        invoiceId: inv.id,
        title: `Renewal invoice ${number} — ${s.tenant_name}`,
        body: `${s.currency} ${(Number(s.amount_cents) / 100).toFixed(2)}, due ${s.renewal_date}`,
        severity: "info",
      });
      await recordAudit(q, {
        actorUserId: null,
        action: "billing.renewal_generated",
        tenantId: s.tenant_id,
        metadata: { source: "scheduler", invoice: number, periodStart: iso(pStart) },
      });
      result.renewalsGenerated++;
    } catch (err) {
      result.errors.push(`renewal ${s.tenant_name}: ${(err as Error).message}`);
    }
  }

  // ---- 2. Overdue sweep -------------------------------------------------
  for (const inv of await listPlatformInvoices(q, { unpaidOnly: true })) {
    if (!isInvoiceOverdue(inv, cfg.overdueGraceDays, now)) continue;
    await createNotification(q, {
      type: "payment_overdue",
      tenantId: inv.tenant_id,
      invoiceId: inv.id,
      title: `Overdue: ${inv.number}`,
      body: `${inv.tenant_name} — due ${inv.due_date}`,
      severity: "attention",
      dedupeKey: `overdue:${inv.id}`,
    });
    result.overdueFlagged++;
  }

  // ---- 3. Reconciliation: poll Fire for pending payments ---------------
  if (fire) {
    for (const inv of await listPlatformInvoices(q, { status: "payment_pending" })) {
      if (!inv.fire_payment_code) continue;
      try {
        const detail = await fire.getPaymentRequest(inv.fire_payment_code);
        const paid = Number(detail.totalAmountPaid ?? 0);
        if (paid >= Number(inv.amount_cents) && Number(detail.countTimesPaid ?? 0) >= 1) {
          const outcome = await applyConfirmedPayment(db, {
            invoiceId: inv.id,
            amountCents: paid,
            currency: inv.currency,
            providerPaymentId: inv.fire_payment_code,
            raw: detail,
            source: "reconciliation",
          });
          if (outcome === "applied") result.reconciled++;
        }
      } catch (err) {
        result.errors.push(`reconcile ${inv.number}: ${(err as Error).message}`);
      }
    }
  }

  await recordAudit(q, {
    actorUserId: null,
    action: "billing.job_run",
    metadata: {
      source: "scheduler",
      renewalsGenerated: result.renewalsGenerated,
      overdueFlagged: result.overdueFlagged,
      reconciled: result.reconciled,
      errors: result.errors.length,
    },
  });
  return result;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
