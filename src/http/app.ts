import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import "./principal.ts";
import { config } from "../config.ts";
import type { Db } from "../db/types.ts";
import { errorHandler, notFound } from "./errors.ts";
import { LoginRateLimiter } from "./rate-limit.ts";
import { adminRoutes } from "../modules/admin/admin.routes.ts";
import { authRoutes } from "../modules/auth/auth.routes.ts";
import { billingAdminRoutes } from "../modules/billing/billing.admin.routes.ts";
import { webhookRoutes } from "../modules/billing/webhook.routes.ts";
import { supportAdminRoutes } from "../modules/support/support.admin.routes.ts";
import { supportRoutes } from "../modules/support/support.routes.ts";
import { customerRoutes } from "../modules/customers/customers.routes.ts";
import { dashboardRoutes } from "../modules/dashboard/dashboard.routes.ts";
import { invoiceRoutes } from "../modules/invoices/invoices.routes.ts";
import { settingsRoutes } from "../modules/settings/settings.routes.ts";
import { teamRoutes } from "../modules/team/team.routes.ts";
import { tenantRoutes } from "../modules/tenants/tenants.routes.ts";
import { userRoutes } from "../modules/users/users.routes.ts";

const adminUiDir = fileURLToPath(new URL("../../web/admin/", import.meta.url));
const appUiDir = fileURLToPath(new URL("../../web/app/", import.meta.url));

export interface AppOptions {
  /** Login brute-force protection. Defaults to on outside tests. */
  loginRateLimiter?: LoginRateLimiter | null;
}

export function createApp(db: Db, options: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy in production so `req.ip` reflects the real client.
  app.set("trust proxy", config.isProduction ? 1 : false);

  // Inbound provider webhooks need the raw body for signature verification, so
  // they mount before the JSON parser and bring their own text parser.
  app.use("/api/webhooks", webhookRoutes(db));

  app.use(express.json({ limit: "100kb" }));

  const rateLimiter =
    options.loginRateLimiter === undefined
      ? config.isTest
        ? null
        : new LoginRateLimiter(config.login)
      : options.loginRateLimiter;

  app.get("/health", async (_req, res) => {
    try {
      await db.bypassRls((q) => q.query("SELECT 1"));
      res.json({ status: "ok" });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });

  app.use("/api/auth", authRoutes(db, rateLimiter ?? undefined));
  app.use("/api/tenants", tenantRoutes(db));
  app.use("/api/users", userRoutes(db));
  app.use("/api/team", teamRoutes(db));
  app.use("/api/dashboard", dashboardRoutes(db));
  app.use("/api/customers", customerRoutes(db));
  app.use("/api/settings", settingsRoutes(db));
  app.use("/api/invoices", invoiceRoutes(db));
  app.use("/api/support", supportRoutes(db));
  // More specific admin prefixes first so they don't fall through the /api/admin router.
  app.use("/api/admin/billing", billingAdminRoutes(db));
  app.use("/api/admin/support", supportAdminRoutes(db));
  app.use("/api/admin", adminRoutes(db));

  // Static single-page apps. Both are plain HTML/CSS/JS that call /api/* with a
  // bearer token — they hold no credentials and are granted no privileges of
  // their own; the server enforces auth + RLS on every call.
  app.use("/admin", express.static(adminUiDir, { extensions: ["html"] }));
  app.use("/app", express.static(appUiDir, { extensions: ["html"] }));

  // The customer app routes on real paths (e.g. /app/invoices/<id>). Any GET
  // under /app that didn't resolve to a real file above gets the SPA shell so
  // client-side routing can take over; anything that looks like a missing asset
  // (has a file extension) falls through to 404.
  app.use("/app", (req, res, next) => {
    if (req.method !== "GET" || path.extname(req.path)) return next();
    res.sendFile(path.join(appUiDir, "index.html"));
  });

  app.use((_req, _res, next) => next(notFound("Route not found")));
  app.use(errorHandler);

  return app;
}
