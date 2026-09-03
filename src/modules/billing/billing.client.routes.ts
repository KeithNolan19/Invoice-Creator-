import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth, requireTenantUser } from "../../auth/middleware.ts";
import { ensureInvoicePaymentLink } from "../../billing/payment-link.ts";
import { withSystemContext } from "../../db/system-context.ts";
import type { Db } from "../../db/types.ts";
import { badRequest, conflict, notFound } from "../../http/errors.ts";
import { qrSvgDataUri } from "../../lib/qrcodegen.ts";
import { getBillingConfigSafe } from "./billing-config.repo.ts";
import { listPlatformInvoices, serializePlatformInvoice } from "./platform-invoices.repo.ts";
import { getSubscriptionForTenant, serializeSubscription } from "./subscriptions.repo.ts";

/**
 * The tenant-facing view of *their own* platform subscription: the plan they're
 * on, when it renews, and the invoices the platform has raised — each with a
 * Fire.com pay-by-bank link + QR code when one has been prepared.
 *
 * Tenant-scoped by RLS. Platform admins manage billing from the Admin Control
 * Centre and are refused here.
 */
export function billingClientRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireTenantUser);

  router.get("/", async (req, res) => {
    const p = requireAuth(req);
    const tenantId = p.tenantId!;
    // The tenant's own subscription + invoices are read under their RLS context;
    // the platform config (admin-only table) is read separately as the system.
    const [data, cfg] = await Promise.all([
      db.withContext(p, async (q) => ({
        sub: await getSubscriptionForTenant(q, tenantId),
        invoices: await listPlatformInvoices(q, { tenantId }),
      })),
      withSystemContext(db, (q) => getBillingConfigSafe(q)),
    ]);

    const invoices = data.invoices.map((i) => {
      const s = serializePlatformInvoice(i, cfg.overdueGraceDays);
      const stillOwed = s.status === "issued" || s.status === "payment_pending";
      return {
        ...s,
        paymentQrSvg: stillOwed && s.hostedPaymentUrl ? qrSvgDataUri(s.hostedPaymentUrl) : null,
      };
    });
    const outstanding = invoices.filter((i) => i.status === "issued" || i.status === "payment_pending");

    res.json({
      subscription: data.sub ? serializeSubscription(data.sub) : null,
      invoices,
      amountDueCents: outstanding.reduce((sum, i) => sum + i.amountCents, 0),
      hasOverdue: outstanding.some((i) => i.overdue),
      businessName: cfg.businessName,
    });
  });

  const idParam = z.string().uuid();

  // Prepare (or fetch) the Fire.com pay-by-bank request for one of the tenant's
  // own outstanding invoices. Money is only ever confirmed by Fire — this just
  // creates the payment link + QR.
  router.post("/invoices/:id/payment-link", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Invoice not found");

    // Ownership + payable check runs in the tenant's own RLS context.
    const owned = await db.withContext(p, async (q) => {
      const rows = await listPlatformInvoices(q, { tenantId: p.tenantId! });
      return rows.find((i) => i.id === id.data) ?? null;
    });
    if (!owned) throw notFound("Invoice not found");
    if (owned.status === "paid") throw conflict("This invoice is already paid.");
    if (owned.status !== "issued" && owned.status !== "payment_pending") {
      throw conflict(`This invoice is ${owned.status}.`);
    }

    // Creating the request needs the platform Fire credentials — system context.
    const outcome = await withSystemContext(db, (q) => ensureInvoicePaymentLink(q, id.data));
    if (outcome.status === "not_found") throw notFound("Invoice not found");
    if (outcome.status === "not_configured") {
      throw badRequest("Online payment isn't available yet. Please contact support.");
    }
    if (outcome.status === "not_payable") throw conflict(`This invoice is ${outcome.invoice.status}.`);
    if (outcome.status === "provider_error") {
      res.status(502).json({ error: { code: "provider_error", message: outcome.message } });
      return;
    }

    res.json({
      hostedUrl: outcome.hostedUrl,
      paymentQrSvg: qrSvgDataUri(outcome.hostedUrl),
      invoice: serializePlatformInvoice(outcome.invoice),
    });
  });

  return router;
}
