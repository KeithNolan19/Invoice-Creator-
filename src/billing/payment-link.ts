import { config } from "../config.ts";
import type { Queryable } from "../db/types.ts";
import { FireClient } from "../integrations/fire/index.ts";
import { recordAudit } from "../modules/admin/audit.ts";
import { getBillingConfigSafe, getFireAuthCredentials } from "../modules/billing/billing-config.repo.ts";
import { createNotification } from "../modules/billing/notifications.repo.ts";
import {
  getPlatformInvoice,
  type PlatformInvoiceRow,
  setPlatformInvoiceStatus,
} from "../modules/billing/platform-invoices.repo.ts";

export type PaymentLinkOutcome =
  | { status: "ok"; invoice: PlatformInvoiceRow; hostedUrl: string }
  | { status: "not_found" }
  | { status: "not_payable"; invoice: PlatformInvoiceRow }
  | { status: "not_configured" }
  | { status: "provider_error"; message: string };

/**
 * Ensures an issued invoice has a Fire.com pay-by-bank request (hosted page +
 * QR). Idempotent: if the invoice already carries a Fire code it just returns
 * the existing hosted URL. Requires admin/system RLS context (reads the
 * platform Fire credentials). Shared by the admin "generate pay link" action,
 * the scheduler, and the tenant-facing "Pay now" button.
 */
export async function ensureInvoicePaymentLink(
  q: Queryable,
  invoiceId: string,
  actorUserId: string | null = null,
): Promise<PaymentLinkOutcome> {
  const inv = await getPlatformInvoice(q, invoiceId);
  if (!inv) return { status: "not_found" };
  if (inv.status !== "issued" && inv.status !== "payment_pending") {
    return { status: "not_payable", invoice: inv };
  }
  if (inv.fire_payment_code && inv.hosted_payment_url) {
    return { status: "ok", invoice: inv, hostedUrl: inv.hosted_payment_url };
  }

  const creds = await getFireAuthCredentials(q);
  const cfg = await getBillingConfigSafe(q);
  if (!creds || !cfg.fireCollectionIcan) return { status: "not_configured" };

  let created;
  try {
    created = await new FireClient(creds).createPaymentRequest({
      amountMinor: Number(inv.amount_cents),
      currency: (inv.currency as "EUR" | "GBP") ?? "EUR",
      myRef: inv.number,
      description: inv.number.slice(0, 18),
      icanTo: Number(cfg.fireCollectionIcan),
    });
  } catch (err) {
    const message = (err as Error).message;
    await createNotification(q, {
      type: "provider_error",
      tenantId: inv.tenant_id,
      invoiceId: inv.id,
      title: `Fire.com error preparing ${inv.number}`,
      body: message,
      severity: "attention",
      dedupeKey: `provider_err:${inv.number}`,
    });
    return { status: "provider_error", message };
  }

  const hostedUrl = `${config.fire.paymentsBaseUrl}/${created.code}`;
  const updated = await setPlatformInvoiceStatus(q, inv.id, "payment_pending", {
    paymentProvider: "fire",
    paymentReference: inv.number,
    firePaymentCode: created.code,
    hostedPaymentUrl: hostedUrl,
    qrGeneratedAt: new Date().toISOString(),
  });
  await recordAudit(q, {
    actorUserId,
    action: "billing.invoice_issued",
    tenantId: inv.tenant_id,
    metadata: { invoice: inv.number, firePaymentCode: created.code },
  });
  return { status: "ok", invoice: updated!, hostedUrl };
}
