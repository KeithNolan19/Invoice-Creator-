import { Router } from "express";
import { authenticate, requireAuth, requireTenantUser } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { listInvoices, serializeInvoice } from "../invoices/invoices.repo.ts";
import { getPaymentIntegrationSafe } from "../settings/payment-integration.repo.ts";
import { getDashboard, serializeDashboard } from "./dashboard.repo.ts";

/**
 * The tenant-user dashboard — "what needs my attention?". Tenant-scoped by RLS;
 * platform admins have their own control centre and are refused here.
 */
export function dashboardRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireTenantUser);

  router.get("/", async (req, res) => {
    const principal = requireAuth(req);
    const data = await db.withContext(principal, async (q) => {
      const [stats, recentInvoices, recentPayments, integration] = await Promise.all([
        getDashboard(q, principal.tenantId!),
        listInvoices(q, { limit: 5 }),
        listInvoices(q, { paymentStatus: "paid", limit: 5 }),
        // Only tenant admins can read the integration row; a member's context
        // sees null and just gets "not connected".
        principal.tenantRole === "admin"
          ? getPaymentIntegrationSafe(q, principal.tenantId!)
          : Promise.resolve(null),
      ]);
      return { stats, recentInvoices, recentPayments, integration };
    });

    res.json({
      ...serializeDashboard(data.stats),
      recentInvoices: data.recentInvoices.map(serializeInvoice),
      recentPayments: data.recentPayments
        .map(serializeInvoice)
        .sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt))),
      paymentIntegration: {
        status: data.integration?.status ?? "not_connected",
        manageable: principal.tenantRole === "admin",
      },
    });
  });

  return router;
}
