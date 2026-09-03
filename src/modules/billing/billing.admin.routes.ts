import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAdmin, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { FireClient } from "../../integrations/fire/index.ts";
import { recordAudit } from "../admin/audit.ts";
import {
  type BillingConfigPatch,
  type FireCredentialsPatch,
  getBillingConfigSafe,
  getFireAuthCredentials,
  recordFireVerification,
  setFireCredentials,
  updateBillingConfigSafe,
} from "./billing-config.repo.ts";

const configSchema = z
  .object({
    businessName: z.string().trim().max(200).nullable().optional(),
    businessAddress: z.string().trim().max(2000).nullable().optional(),
    businessTaxNumber: z.string().trim().max(64).nullable().optional(),
    businessContactEmail: z.string().trim().email().max(200).nullable().optional(),
    defaultCurrency: z.enum(["EUR", "GBP"]).optional(),
    invoiceNumberPrefix: z.string().trim().min(1).max(16).optional(),
    renewalReminderDays: z.number().int().min(0).max(90).optional(),
    overdueGraceDays: z.number().int().min(0).max(90).optional(),
    yearlyDiscountPct: z.number().min(0).max(99).optional(),
    // Fire credentials — write-only. Never echoed back.
    fireClientId: z.string().trim().min(1).max(200).optional(),
    fireClientKey: z.string().trim().min(1).max(400).optional(),
    fireRefreshToken: z.string().trim().min(1).max(400).optional(),
    fireWebhookPrivateToken: z.string().trim().min(1).max(400).optional(),
    fireWebhookKid: z.string().trim().max(200).nullable().optional(),
    fireCollectionIcan: z.number().int().positive().nullable().optional(),
  })
  .strict();

export function billingAdminRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireAdmin);

  router.get("/config", async (req, res) => {
    const principal = requireAuth(req);
    const config = await db.withContext(principal, (q) => getBillingConfigSafe(q));
    res.json({ config });
  });

  router.put("/config", async (req, res) => {
    const principal = requireAuth(req);
    const body = configSchema.parse(req.body);

    const safePatch: BillingConfigPatch = {
      businessName: body.businessName,
      businessAddress: body.businessAddress,
      businessTaxNumber: body.businessTaxNumber,
      businessContactEmail: body.businessContactEmail,
      defaultCurrency: body.defaultCurrency,
      invoiceNumberPrefix: body.invoiceNumberPrefix,
      renewalReminderDays: body.renewalReminderDays,
      overdueGraceDays: body.overdueGraceDays,
      yearlyDiscountPct: body.yearlyDiscountPct,
    };
    const firePatch: FireCredentialsPatch = {
      clientId: body.fireClientId,
      clientKey: body.fireClientKey,
      refreshToken: body.fireRefreshToken,
      webhookPrivateToken: body.fireWebhookPrivateToken,
      webhookKid: body.fireWebhookKid,
      collectionIcan: body.fireCollectionIcan,
    };
    const fireFieldsProvided = Object.values(firePatch).some((v) => v !== undefined);

    const config = await db.withContext(principal, async (q) => {
      await updateBillingConfigSafe(q, safePatch, principal.userId);
      if (fireFieldsProvided) await setFireCredentials(q, firePatch, principal.userId);
      await recordAudit(q, {
        actorUserId: principal.userId,
        action: "billing.config_updated",
        // Never log secret values — only which fields changed.
        metadata: {
          safeFields: Object.entries(safePatch).filter(([, v]) => v !== undefined).map(([k]) => k),
          fireFields: Object.entries(firePatch).filter(([, v]) => v !== undefined).map(([k]) => k),
        },
      });
      return getBillingConfigSafe(q);
    });
    res.json({ config });
  });

  // Verify the stored Fire credentials actually authenticate.
  router.post("/config/verify-fire", async (req, res) => {
    const principal = requireAuth(req);
    const creds = await db.withContext(principal, (q) => getFireAuthCredentials(q));
    if (!creds) {
      res.status(400).json({ error: { code: "not_configured", message: "Fire.com API credentials are incomplete" } });
      return;
    }
    try {
      const client = new FireClient(creds);
      const info = await client.verifyCredentials();
      const config = await db.withContext(principal, async (q) => {
        await recordFireVerification(q, { businessId: String(info.businessId), error: null });
        await recordAudit(q, {
          actorUserId: principal.userId,
          action: "billing.fire_verified",
          metadata: { businessId: info.businessId, permissions: info.permissions },
        });
        return getBillingConfigSafe(q);
      });
      res.json({ ok: true, businessId: info.businessId, permissions: info.permissions, config });
    } catch (err) {
      const message = (err as Error).message;
      await db.withContext(principal, (q) => recordFireVerification(q, { error: message })).catch(() => undefined);
      res.status(502).json({ ok: false, error: { code: "fire_error", message } });
    }
  });

  return router;
}
