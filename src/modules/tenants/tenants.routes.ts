import { Router } from "express";
import { authenticate, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { listTenants, serializeTenant } from "./tenants.repo.ts";

export function tenantRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));

  // Admins see every tenant; a tenant user sees only their own (enforced by RLS).
  router.get("/", async (req, res) => {
    const principal = requireAuth(req);
    const rows = await db.withContext(principal, (q) => listTenants(q));
    res.json({ tenants: rows.map(serializeTenant) });
  });

  return router;
}
