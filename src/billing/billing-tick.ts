import type { Db, Queryable } from "../db/types.ts";
import { withSystemContext } from "../db/system-context.ts";
import { FireClient } from "../integrations/fire/index.ts";
import { recordAudit } from "../modules/admin/audit.ts";
import { getBillingConfigSafe, getFireAuthCredentials } from "../modules/billing/billing-config.repo.ts";
import { createNotification } from "../modules/billing/notifications.repo.ts";
import { listPlatformInvoices } from "../modules/billing/platform-invoices.repo.ts";
import { listActiveSubscriptions, markRenewalGenerated } from "../modules/billing/subscriptions.repo.ts";
import { applyConfirmedPayment } from "./apply-payment.ts";
import { generateSubscriptionInvoice } from "./generate-invoice.ts";
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

  // Serialise ticks — if another run holds the lock, bail cheaply. Only skip on
  // an explicit `false`; if the function is unavailable (some environments) we
  // proceed, since the DB unique constraints already make double-work harmless.
  try {
    const lock = await q.query<{ locked: boolean | null }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('billing-tick')) AS locked",
    );
    if (lock.rows[0]?.locked === false) return { ...result, skipped: "another tick is running" };
  } catch {
    /* advisory locks unsupported here — rely on the unique constraints */
  }

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

      const gen = await generateSubscriptionInvoice(q, {
        subscription: s,
        periodStart: s.renewal_date,
        periodEnd: iso(periodEnd(renewalDate, s.billing_interval)),
        dueDate: s.renewal_date,
        source: "scheduler",
      });
      await markRenewalGenerated(q, s.id, s.renewal_date);
      if (gen) result.renewalsGenerated++;
    } catch (err) {
      result.errors.push(`renewal ${s.tenant_name}: ${(err as Error).message}`);
    }
  }

  // ---- 2. Overdue sweep — one notification per invoice (deduped) --------
  for (const inv of await listPlatformInvoices(q, { unpaidOnly: true })) {
    if (!isInvoiceOverdue(inv, cfg.overdueGraceDays, now)) continue;
    const created = await createNotification(q, {
      type: "payment_overdue",
      tenantId: inv.tenant_id,
      invoiceId: inv.id,
      title: `Overdue: ${inv.number}`,
      body: `${inv.tenant_name} — due ${inv.due_date}`,
      severity: "attention",
      dedupeKey: `overdue:${inv.id}`,
    });
    if (created) result.overdueFlagged++;
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
