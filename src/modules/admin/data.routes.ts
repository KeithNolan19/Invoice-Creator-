import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAdmin, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { notFound } from "../../http/errors.ts";
import { getDataOverview, getTenantData } from "./data.repo.ts";

/** Read-only data browser — see what tenants have created. Platform admin only. */
export function dataRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireAdmin);

  router.get("/overview", async (req, res) => {
    const p = requireAuth(req);
    res.json(await db.withContext(p, (q) => getDataOverview(q)));
  });

  router.get("/tenants/:id", async (req, res) => {
    const p = requireAuth(req);
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");
    const bundle = await db.withContext(p, (q) => getTenantData(q, id.data));
    if (!bundle.tenant) throw notFound("Tenant not found");
    res.json(bundle);
  });

  return router;
}
