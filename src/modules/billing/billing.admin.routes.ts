import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { config } from "../../config.ts";
import { authenticate, requireAdmin, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { applyConfirmedPayment } from "../../billing/apply-payment.ts";
import { runBillingTick } from "../../billing/billing-tick.ts";
import { FireClient } from "../../integrations/fire/index.ts";
import { badRequest, conflict, notFound } from "../../http/errors.ts";
import { getTenantById } from "../tenants/tenants.repo.ts";
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
import { listPlans, serializePlan } from "./plans.repo.ts";
import {
  cancelSubscription,
  getSubscriptionForTenant,
  serializeSubscription,
  setSubscription,
} from "./subscriptions.repo.ts";
import {
  allocatePlatformInvoiceNumber,
  getPlatformInvoice,
  insertPlatformInvoice,
  listPlatformInvoices,
  serializePlatformInvoice,
  setPlatformInvoiceStatus,
} from "./platform-invoices.repo.ts";

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
    schedulerEnabled: z.boolean().optional(),
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
      schedulerEnabled: body.schedulerEnabled,
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

  // ---- Plans -----------------------------------------------------------
  router.get("/plans", async (req, res) => {
    const p = requireAuth(req);
    const rows = await db.withContext(p, (q) => listPlans(q, { includeInactive: true }));
    res.json({ plans: rows.map(serializePlan) });
  });

  // ---- Per-tenant billing --------------------------------------------
  const idParam = z.string().uuid();

  const tenantBilling = async (db2: Db, p: ReturnType<typeof requireAuth>, tenantId: string) =>
    db2.withContext(p, async (q) => {
      const tenant = await getTenantById(q, tenantId);
      if (!tenant) return null;
      const [sub, invoices, activeUsers] = await Promise.all([
        getSubscriptionForTenant(q, tenantId),
        listPlatformInvoices(q, { tenantId }),
        q.query<{ n: number }>(
          "SELECT count(*)::int n FROM users WHERE tenant_id = $1 AND disabled_at IS NULL",
          [tenantId],
        ),
      ]);
      const cfg = await getBillingConfigSafe(q);
      const userCount = activeUsers.rows[0]!.n;
      return {
        subscription: sub ? serializeSubscription(sub) : null,
        invoices: invoices.map((i) => serializePlatformInvoice(i, cfg.overdueGraceDays)),
        activeUserCount: userCount,
        outgrown: sub != null && userCount > sub.plan_max_users,
      };
    });

  router.get("/tenants/:id", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");
    const detail = await tenantBilling(db, p, id.data);
    if (!detail) throw notFound("Tenant not found");
    res.json(detail);
  });

  const subSchema = z
    .object({
      planId: z.string().uuid(),
      billingInterval: z.enum(["day", "month", "year"]),
    })
    .strict();

  router.put("/tenants/:id/subscription", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");
    const body = subSchema.parse(req.body);
    const out = await db.withContext(p, async (q) => {
      const tenant = await getTenantById(q, id.data);
      if (!tenant) return null;
      const sub = await setSubscription(q, {
        tenantId: id.data,
        planId: body.planId,
        billingInterval: body.billingInterval,
        createdBy: p.userId,
      });
      await recordAudit(q, {
        actorUserId: p.userId,
        action: "billing.subscription_set",
        tenantId: id.data,
        metadata: { planId: body.planId, interval: body.billingInterval, amountCents: Number(sub.amount_cents) },
      });
      return serializeSubscription(sub);
    });
    if (!out) throw notFound("Tenant not found");
    res.json({ subscription: out });
  });

  router.delete("/tenants/:id/subscription", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");
    await db.withContext(p, (q) => cancelSubscription(q, id.data, false));
    res.status(204).end();
  });

  // ---- Invoices ------------------------------------------------------
  const adhocSchema = z
    .object({
      description: z.string().trim().min(1).max(300),
      amountCents: z.number().int().min(0),
      currency: z.enum(["EUR", "GBP"]),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strict();

  router.post("/tenants/:id/invoices", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");
    const body = adhocSchema.parse(req.body);
    const out = await db.withContext(p, async (q) => {
      const tenant = await getTenantById(q, id.data);
      if (!tenant) return null;
      const number = await allocatePlatformInvoiceNumber(q);
      const inv = await insertPlatformInvoice(q, {
        tenantId: id.data,
        number,
        subscriptionId: null,
        kind: "adhoc",
        dueDate: body.dueDate,
        description: body.description,
        currency: body.currency,
        amountCents: body.amountCents,
        createdBy: p.userId,
      });
      await recordAudit(q, {
        actorUserId: p.userId,
        action: "billing.invoice_created",
        tenantId: id.data,
        metadata: { invoice: number, amountCents: body.amountCents },
      });
      return serializePlatformInvoice(inv!);
    });
    if (!out) throw notFound("Tenant not found");
    res.status(201).json({ invoice: out });
  });

  const invoiceAction = (
    to: "issued" | "cancelled",
    auditAction: "billing.invoice_issued" | "billing.invoice_cancelled",
  ) =>
    async (req: Request, res: Response) => {
      const p = requireAuth(req);
      const id = idParam.safeParse(req.params.id);
      if (!id.success) throw notFound("Invoice not found");
      const out = await db.withContext(p, async (q) => {
        const inv = await getPlatformInvoice(q, id.data);
        if (!inv) return null;
        try {
          const updated = await setPlatformInvoiceStatus(q, id.data, to);
          await recordAudit(q, {
            actorUserId: p.userId,
            action: auditAction,
            tenantId: inv.tenant_id,
            metadata: { invoice: inv.number },
          });
          return serializePlatformInvoice(updated!);
        } catch (err) {
          throw conflict((err as Error).message);
        }
      });
      if (!out) throw notFound("Invoice not found");
      res.json({ invoice: out });
    };

  router.post("/invoices/:id/issue", invoiceAction("issued", "billing.invoice_issued"));
  router.post("/invoices/:id/cancel", invoiceAction("cancelled", "billing.invoice_cancelled"));

  // Create the Fire.com pay link + QR for an issued invoice (also runs automatically
  // via the scheduler; this is for issuing one on demand / testing).
  router.post("/invoices/:id/payment-link", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Invoice not found");

    const inv = await db.withContext(p, (q) => getPlatformInvoice(q, id.data));
    if (!inv) throw notFound("Invoice not found");
    if (inv.status !== "issued" && inv.status !== "payment_pending") {
      throw conflict(`invoice is ${inv.status}`);
    }
    if (inv.fire_payment_code) {
      res.json({ invoice: serializePlatformInvoice(inv), hostedUrl: inv.hosted_payment_url });
      return;
    }
    const fire = await db.withContext(p, (q) => getFireAuthCredentials(q));
    const cfg = await db.withContext(p, (q) => getBillingConfigSafe(q));
    if (!fire || !cfg.fireCollectionIcan) throw badRequest("Fire.com is not fully configured");

    let created;
    try {
      created = await new FireClient(fire).createPaymentRequest({
        amountMinor: Number(inv.amount_cents),
        currency: (inv.currency as "EUR" | "GBP") ?? "EUR",
        myRef: inv.number,
        description: inv.number.slice(0, 18),
        icanTo: Number(cfg.fireCollectionIcan),
      });
    } catch (err) {
      res.status(502).json({ error: { code: "fire_error", message: (err as Error).message } });
      return;
    }
    const updated = await db.withContext(p, async (q) => {
      const u = await setPlatformInvoiceStatus(q, id.data, "payment_pending", {
        paymentProvider: "fire",
        paymentReference: inv.number,
        firePaymentCode: created.code,
        hostedPaymentUrl: `${config.fire.paymentsBaseUrl}/${created.code}`,
        qrGeneratedAt: new Date().toISOString(),
      });
      await recordAudit(q, {
        actorUserId: p.userId,
        action: "billing.invoice_issued",
        tenantId: inv.tenant_id,
        metadata: { invoice: inv.number, firePaymentCode: created.code },
      });
      return u!;
    });
    res.json({
      invoice: serializePlatformInvoice(updated),
      hostedUrl: `${config.fire.paymentsBaseUrl}/${created.code}`,
    });
  });

  const recordPaymentSchema = z
    .object({
      amountCents: z.number().int().min(1),
      currency: z.enum(["EUR", "GBP"]),
      reference: z.string().trim().max(140).optional(),
    })
    .strict();

  router.post("/invoices/:id/record-payment", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Invoice not found");
    const body = recordPaymentSchema.parse(req.body);
    const outcome = await applyConfirmedPayment(db, {
      invoiceId: id.data,
      amountCents: body.amountCents,
      currency: body.currency,
      providerPaymentId: body.reference ?? "manual",
      raw: { manual: true, recordedBy: p.userId, reference: body.reference },
      source: "manual",
    });
    if (outcome === "invoice_not_found") throw notFound("Invoice not found");
    await db.withContext(p, (q) =>
      recordAudit(q, {
        actorUserId: p.userId,
        action: "billing.external_payment_recorded",
        metadata: { invoiceId: id.data, amountCents: body.amountCents, outcome },
      }),
    );
    res.json({ outcome });
  });

  // Run the scheduled billing work now (renewals, overdue, reconciliation).
  router.post("/tick", async (_req, res) => {
    const result = await runBillingTick(db);
    res.json(result);
  });

  // ---- Dashboard summary -------------------------------------------
  router.get("/summary", async (req, res) => {
    const p = requireAuth(req);
    const s = await db.withContext(p, async (q) => {
      const { rows } = await q.query<{
        active_subs: number;
        renewing_7d: number;
        outstanding_count: number;
        outstanding_cents: string;
        paid_30d: number;
        suspended_unpaid: number;
        unread_notifications: number;
      }>(`
        SELECT
          (SELECT count(*) FROM tenant_subscriptions WHERE status = 'active')::int AS active_subs,
          (SELECT count(*) FROM tenant_subscriptions WHERE status = 'active'
             AND renewal_date <= current_date + 7)::int AS renewing_7d,
          (SELECT count(*) FROM platform_invoices WHERE status IN ('issued','payment_pending'))::int AS outstanding_count,
          (SELECT COALESCE(sum(amount_cents),0) FROM platform_invoices WHERE status IN ('issued','payment_pending'))::text AS outstanding_cents,
          (SELECT count(*) FROM platform_invoices WHERE status = 'paid' AND paid_at > now() - interval '30 days')::int AS paid_30d,
          (SELECT count(*) FROM tenants WHERE status = 'suspended' AND suspension_reason = 'unpaid')::int AS suspended_unpaid,
          (SELECT count(*) FROM admin_notifications WHERE read_at IS NULL)::int AS unread_notifications
      `);
      return rows[0]!;
    });
    res.json({
      activeSubscriptions: s.active_subs,
      renewingWithin7Days: s.renewing_7d,
      outstanding: { count: s.outstanding_count, totalCents: Number(s.outstanding_cents) },
      paidLast30Days: s.paid_30d,
      suspendedUnpaid: s.suspended_unpaid,
      unreadNotifications: s.unread_notifications,
    });
  });

  return router;
}
