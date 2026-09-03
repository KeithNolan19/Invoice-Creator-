import express, { Router } from "express";
import type { Db } from "../../db/types.ts";
import { withSystemContext } from "../../db/system-context.ts";
import { verifyFireWebhook } from "../../integrations/fire/index.ts";
import { recordAudit } from "../admin/audit.ts";
import { getFirePlatformConfig } from "./billing-config.repo.ts";

/**
 * Inbound Fire.com webhooks. Mounted BEFORE the JSON body parser so the exact
 * bytes are available for signature verification.
 *
 * Phase 0: verify the HS256 signature against the stored webhook private token,
 * and record receipt in the audit log. Persisting events to
 * `platform_payment_events` and applying confirmed payments to invoices lands in
 * Phase 4 (those tables do not exist yet).
 */
export function webhookRoutes(db: Db): Router {
  const router = Router();
  router.use(express.text({ type: () => true, limit: "1mb" }));

  router.post("/fire", async (req, res) => {
    const raw = typeof req.body === "string" ? req.body : "";

    let events;
    try {
      const cfg = await withSystemContext(db, (q) => getFirePlatformConfig(q));
      if (!cfg) {
        res.status(503).json({ error: "billing is not configured" });
        return;
      }
      events = verifyFireWebhook(raw, cfg.webhookPrivateToken, cfg.webhookKid ?? undefined);
    } catch (err) {
      await withSystemContext(db, (q) =>
        recordAudit(q, {
          actorUserId: null,
          action: "billing.webhook_failed",
          metadata: { source: "webhook", error: (err as Error).message },
        }),
      ).catch(() => undefined);
      res.status(401).json({ error: "webhook verification failed" });
      return;
    }

    await withSystemContext(db, (q) =>
      recordAudit(q, {
        actorUserId: null,
        action: "billing.webhook_received",
        metadata: {
          source: "webhook",
          eventCount: events.length,
          types: events.map((e) => e.type).filter(Boolean),
        },
      }),
    ).catch(() => undefined);

    // Ack fast; Phase 4 does the idempotent processing.
    res.status(200).json({ received: events.length });
  });

  return router;
}
