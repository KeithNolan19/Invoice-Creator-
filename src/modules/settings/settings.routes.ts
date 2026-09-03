import { Router } from "express";
import { z } from "zod";
import {
  authenticate,
  requireAuth,
  requireTenantAdmin,
  requireTenantUser,
} from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { notFound } from "../../http/errors.ts";
import {
  getPaymentIntegrationSafe,
  serializePaymentIntegration,
} from "./payment-integration.repo.ts";
import {
  getTenantSettings,
  serializeTenantSettings,
  updateBusinessSettings,
} from "./settings.repo.ts";

const nullableStr = (max: number) => z.string().trim().max(max).nullish();

const businessSchema = z
  .object({
    businessName: nullableStr(200),
    addressLine1: nullableStr(200),
    addressLine2: nullableStr(200),
    city: nullableStr(120),
    region: nullableStr(120),
    postalCode: nullableStr(32),
    country: nullableStr(120),
    contactEmail: z.string().trim().email().max(200).nullish(),
    contactPhone: nullableStr(64),
    taxNumber: nullableStr(64),
    taxScheme: nullableStr(64),
    defaultCurrency: z.string().trim().length(3).toUpperCase().optional(),
    defaultDueDays: z.number().int().min(0).max(365).optional(),
    defaultNotes: nullableStr(2000),
    defaultPaymentTerms: nullableStr(2000),
    invoiceNumberPrefix: z.string().trim().min(1).max(16).optional(),
  })
  .strict();

export function settingsRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));

  // Business details — any tenant user may read; only a tenant admin may write.
  router.get("/business", requireTenantUser, async (req, res) => {
    const principal = requireAuth(req);
    const row = await db.withContext(principal, (q) => getTenantSettings(q, principal.tenantId!));
    if (!row) throw notFound("Business settings not found");
    res.json({ settings: serializeTenantSettings(row) });
  });

  router.put("/business", requireTenantAdmin, async (req, res) => {
    const principal = requireAuth(req);
    const body = businessSchema.parse(req.body);
    const row = await db.withContext(principal, (q) =>
      updateBusinessSettings(q, principal.tenantId!, body),
    );
    if (!row) throw notFound("Business settings not found");
    res.json({ settings: serializeTenantSettings(row) });
  });

  // Payments (Fire.com) — tenant admin only. Read-only status in Stage 2;
  // there is no connect / disconnect endpoint yet (the integration stage adds it).
  router.get("/payment-integration", requireTenantAdmin, async (req, res) => {
    const principal = requireAuth(req);
    const row = await db.withContext(principal, (q) =>
      getPaymentIntegrationSafe(q, principal.tenantId!),
    );
    res.json({
      integration: serializePaymentIntegration(row),
      configurable: false,
      note: "Fire.com integration will be enabled in a later stage. Credentials will be stored server-side and are never exposed to the browser.",
    });
  });

  return router;
}
