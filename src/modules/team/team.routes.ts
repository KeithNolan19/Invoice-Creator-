import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth, requireTenantAdmin } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { badRequest, conflict, notFound } from "../../http/errors.ts";
import { listUsers, serializeUser, setTenantRole } from "../users/users.repo.ts";

const idParam = z.string().uuid();
const roleSchema = z.object({ tenantRole: z.enum(["admin", "member"]) }).strict();

/**
 * Minimal team-management surface for Stage 1 — enough to exercise the
 * tenant-admin authorization boundary. Full invitations land in Stage 2.
 *
 * Every route is behind `authenticate` + `requireTenantAdmin`, and every write
 * runs inside the caller's tenant RLS context, so a member (or another tenant,
 * or a forged token) cannot reach or affect anything here.
 */
export function teamRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireTenantAdmin);

  router.get("/members", async (req, res) => {
    const principal = requireAuth(req);
    const rows = await db.withContext(principal, (q) =>
      listUsers(q, { tenantId: principal.tenantId }),
    );
    res.json({ members: rows.map(serializeUser) });
  });

  router.patch("/members/:id", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Member not found");
    const { tenantRole } = roleSchema.parse(req.body);

    // Guard against self-lockout: an admin changes another admin's role, not
    // their own.
    if (id.data === principal.userId) {
      throw conflict("You cannot change your own role — ask another tenant admin");
    }

    const updated = await db.withContext(principal, (q) => setTenantRole(q, id.data, tenantRole));
    if (!updated) throw notFound("Member not found");
    if (updated.tenant_id !== principal.tenantId) {
      // Defensive — RLS already prevents this.
      throw badRequest("Member is not in your tenant");
    }
    res.json({ member: serializeUser(updated) });
  });

  return router;
}
