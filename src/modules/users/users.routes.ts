import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { listUsers, serializeUser } from "./users.repo.ts";

const listQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
});

export function userRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));

  // A tenant user sees only accounts in their own tenant (RLS); an admin sees
  // everyone and may narrow with ?tenantId=.
  router.get("/", async (req, res) => {
    const principal = requireAuth(req);
    const { tenantId } = listQuerySchema.parse(req.query);
    const rows = await db.withContext(principal, (q) =>
      listUsers(q, { tenantId: principal.isAdmin ? tenantId : null }),
    );
    res.json({ users: rows.map(serializeUser) });
  });

  return router;
}
