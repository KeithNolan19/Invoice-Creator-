import { fileURLToPath } from "node:url";
import express, { type Express } from "express";
import "./principal.ts";
import { config } from "../config.ts";
import type { Db } from "../db/types.ts";
import { errorHandler, notFound } from "./errors.ts";
import { LoginRateLimiter } from "./rate-limit.ts";
import { adminRoutes } from "../modules/admin/admin.routes.ts";
import { authRoutes } from "../modules/auth/auth.routes.ts";
import { invoiceRoutes } from "../modules/invoices/invoices.routes.ts";
import { tenantRoutes } from "../modules/tenants/tenants.routes.ts";
import { userRoutes } from "../modules/users/users.routes.ts";

const adminUiDir = fileURLToPath(new URL("../../web/admin/", import.meta.url));

export interface AppOptions {
  /** Login brute-force protection. Defaults to on outside tests. */
  loginRateLimiter?: LoginRateLimiter | null;
}

export function createApp(db: Db, options: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy in production so `req.ip` reflects the real client.
  app.set("trust proxy", config.isProduction ? 1 : false);
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
  app.use("/api/invoices", invoiceRoutes(db));
  app.use("/api/admin", adminRoutes(db));

  // Static admin UI. Plain HTML/CSS/JS that calls /api/admin/* with a bearer
  // token — it holds no credentials and is granted no privileges of its own.
  app.use("/admin", express.static(adminUiDir, { extensions: ["html"] }));

  app.use((_req, _res, next) => next(notFound("Route not found")));
  app.use(errorHandler);

  return app;
}
