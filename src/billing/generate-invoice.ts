import { config } from "../config.ts";
import type { Queryable } from "../db/types.ts";
import { FireClient } from "../integrations/fire/index.ts";
import { recordAudit } from "../modules/admin/audit.ts";
import { getBillingConfigSafe, getFireAuthCredentials } from "../modules/billing/billing-config.repo.ts";
import { createNotification } from "../modules/billing/notifications.repo.ts";
import {
  allocatePlatformInvoiceNumber,
  insertPlatformInvoice,
  type PlatformInvoiceRow,
  setPlatformInvoiceStatus,
} from "../modules/billing/platform-invoices.repo.ts";
import type { SubscriptionRow } from "../modules/billing/subscriptions.repo.ts";

export interface GenerateResult {
  invoice: PlatformInvoiceRow;
  hostedUrl: string | null;
}

/**
 * Creates one subscription invoice for a billing period: allocate number →
 * insert (idempotent per `(tenant, subscription, period_start)`) → issue → if
 * Fire.com is configured, create the payment request + QR and move it to
 * `payment_pending` → raise the "renewal invoice generated" notification.
 *
 * Used by the scheduler (upcoming period), by tenant creation (the day-one
 * invoice) and by any on-demand generation. Returns null if the invoice for
 * that period already exists.
 */
export async function generateSubscriptionInvoice(
  q: Queryable,
  args: {
    subscription: SubscriptionRow;
    periodStart: string; // YYYY-MM-DD
    periodEnd: string;
    dueDate: string;
    createdBy?: string | null;
    source: "scheduler" | "tenant_create" | "admin";
  },
): Promise<GenerateResult | null> {
  const s = args.subscription;
  const number = await allocatePlatformInvoiceNumber(q);
  const inv = await insertPlatformInvoice(q, {
    tenantId: s.tenant_id,
    number,
    subscriptionId: s.id,
    kind: "subscription",
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    dueDate: args.dueDate,
    description: `${s.plan_name} — ${args.periodStart}`,
    currency: s.currency,
    amountCents: Number(s.amount_cents),
    createdBy: args.createdBy ?? null,
  });
  if (!inv) return null; // already generated for this period

  let issued = (await setPlatformInvoiceStatus(q, inv.id, "issued"))!;
  let hostedUrl: string | null = null;

  const cfg = await getBillingConfigSafe(q);
  const fireCreds = await getFireAuthCredentials(q);
  if (fireCreds && cfg.fireCollectionIcan) {
    try {
      const created = await new FireClient(fireCreds).createPaymentRequest({
        amountMinor: Number(s.amount_cents),
        currency: (s.currency as "EUR" | "GBP") ?? "EUR",
        myRef: number,
        description: number.slice(0, 18),
        icanTo: Number(cfg.fireCollectionIcan),
      });
      hostedUrl = `${config.fire.paymentsBaseUrl}/${created.code}`;
      issued = (await setPlatformInvoiceStatus(q, inv.id, "payment_pending", {
        paymentProvider: "fire",
        paymentReference: number,
        firePaymentCode: created.code,
        hostedPaymentUrl: hostedUrl,
        qrGeneratedAt: new Date().toISOString(),
      }))!;
    } catch (err) {
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
    title: `Invoice ${number} — ${s.tenant_name}`,
    body: `${s.currency} ${(Number(s.amount_cents) / 100).toFixed(2)}, due ${args.dueDate}`,
    severity: "info",
  });
  await recordAudit(q, {
    actorUserId: args.createdBy ?? null,
    action: args.source === "scheduler" ? "billing.renewal_generated" : "billing.invoice_created",
    tenantId: s.tenant_id,
    metadata: { source: args.source, invoice: number, periodStart: args.periodStart },
  });

  return { invoice: issued, hostedUrl };
}
