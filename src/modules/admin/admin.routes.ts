import { randomBytes } from "node:crypto";
import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { authenticate, requireAdmin, requireAuth } from "../../auth/middleware.ts";
import { assertPasswordAllowed, hashPassword } from "../../auth/password.ts";
import type { Db } from "../../db/types.ts";
import { badRequest, conflict, notFound } from "../../http/errors.ts";
import type { AuthPrincipal } from "../../http/principal.ts";
import {
  createTenant,
  getTenantById,
  getTenantUsage,
  listTenantsFiltered,
  serializeTenant,
  setTenantStatus,
  type TenantStatus,
} from "../tenants/tenants.repo.ts";
import {
  countTenantUsers,
  createTenantUser,
  disableUser,
  enableUser,
  getUserById,
  listUsers,
  serializeUser,
} from "../users/users.repo.ts";
import { getDashboardStats, serializeDashboard, slugify } from "./admin.repo.ts";
import { listAuditLogs, recordAudit, serializeAuditLog } from "./audit.ts";

const idParam = z.string().uuid();

const createTenantSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().min(1).max(48).regex(/^[a-z0-9-]+$/).optional(),
  })
  .strict();

const createUserSchema = z
  .object({
    email: z.string().trim().email().max(200),
    name: z.string().trim().min(1).max(200),
    // Optional: when omitted a one-time password is generated and returned once.
    // Strength is enforced by assertPasswordAllowed below.
    password: z.string().min(1).max(200).optional(),
  })
  .strict();

/** POST endpoints that take no body reject any body outright. */
const noBody = z.object({}).strict();

const tenantListQuery = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

const auditQuery = z.object({
  tenantId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export function adminRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireAdmin);

  const loadTenant = (principal: AuthPrincipal, id: string) =>
    db.withContext(principal, (q) => getTenantById(q, id));

  // --- Dashboard ---------------------------------------------------------

  router.get("/dashboard", async (req, res) => {
    const principal = requireAuth(req);
    const stats = await db.withContext(principal, (q) => getDashboardStats(q));
    res.json({ stats: serializeDashboard(stats) });
  });

  // --- Tenants ----------------------------------------------------------

  router.get("/tenants", async (req, res) => {
    const principal = requireAuth(req);
    const filter = tenantListQuery.parse(req.query);
    const rows = await db.withContext(principal, (q) => listTenantsFiltered(q, filter));
    res.json({ tenants: rows.map(serializeTenant) });
  });

  router.post("/tenants", async (req, res) => {
    const principal = requireAuth(req);
    const body = createTenantSchema.parse(req.body);
    const slug = body.slug ?? slugify(body.name);
    if (!slug) throw badRequest("Could not derive a slug from the name; provide one explicitly");

    try {
      const tenant = await db.withContext(principal, async (q) => {
        const created = await createTenant(q, { name: body.name, slug });
        // Every tenant gets exactly one settings row (matches migration 008's
        // backfill for pre-existing tenants).
        await q.query(
          "INSERT INTO tenant_settings (tenant_id, business_name) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING",
          [created.id, created.name],
        );
        await recordAudit(q, {
          actorUserId: principal.userId,
          action: "tenant.created",
          tenantId: created.id,
          metadata: { name: created.name, slug: created.slug },
        });
        return created;
      });
      res.status(201).json({ tenant: serializeTenant(tenant) });
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw conflict(`A tenant with slug "${slug}" already exists`);
      }
      throw err;
    }
  });

  router.get("/tenants/:id", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");

    const detail = await db.withContext(principal, async (q) => {
      const tenant = await getTenantById(q, id.data);
      if (!tenant) return null;
      const [usage, users] = await Promise.all([
        getTenantUsage(q, id.data),
        listUsers(q, { tenantId: id.data }),
      ]);
      return { tenant, usage, users };
    });
    if (!detail) throw notFound("Tenant not found");

    res.json({
      tenant: serializeTenant(detail.tenant),
      usage: {
        userCount: detail.usage.user_count,
        activeUserCount: detail.usage.active_user_count,
        invoiceCount: detail.usage.invoice_count,
        lastInvoiceAt: detail.usage.last_invoice_at,
        lastAdminActionAt: detail.usage.last_admin_action_at,
      },
      users: detail.users.map(serializeUser),
    });
  });

  const changeStatus = (action: "suspend" | "reactivate") => async (req: Request, res: Response) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");

    noBody.parse(req.body ?? {});

    const target: TenantStatus = action === "suspend" ? "suspended" : "active";
    const current = await loadTenant(principal, id.data);
    if (!current) throw notFound("Tenant not found");
    if (current.status === target) {
      throw conflict(`Tenant is already ${target === "active" ? "active" : "suspended"}`);
    }

    const updated = await db.withContext(principal, async (q) => {
      const row = await setTenantStatus(q, id.data, target);
      if (!row) return null;
      await recordAudit(q, {
        actorUserId: principal.userId,
        action: action === "suspend" ? "tenant.suspended" : "tenant.reactivated",
        tenantId: row.id,
        metadata: { previousStatus: current.status },
      });
      return row;
    });
    if (!updated) throw notFound("Tenant not found");
    res.json({ tenant: serializeTenant(updated) });
  };

  router.post("/tenants/:id/suspend", changeStatus("suspend"));
  router.post("/tenants/:id/reactivate", changeStatus("reactivate"));

  // --- Users ----------------------------------------------------------

  router.get("/tenants/:id/users", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");

    const result = await db.withContext(principal, async (q) => {
      const tenant = await getTenantById(q, id.data);
      if (!tenant) return null;
      return listUsers(q, { tenantId: id.data });
    });
    if (!result) throw notFound("Tenant not found");
    res.json({ users: result.map(serializeUser) });
  });

  router.post("/tenants/:id/users", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Tenant not found");
    const body = createUserSchema.parse(req.body);
    if (body.password) assertPasswordAllowed(body.password);

    const generated = body.password ? null : randomBytes(12).toString("base64url");
    const passwordHash = await hashPassword(body.password ?? generated!);

    try {
      const user = await db.withContext(principal, async (q) => {
        const tenant = await getTenantById(q, id.data);
        if (!tenant) return null;
        // tenantId comes from the URL, never the body — an admin action cannot
        // place a user in the wrong tenant. The first user provisioned for a
        // tenant becomes its tenant admin; later ones are members.
        const firstUser = (await countTenantUsers(q, id.data)) === 0;
        const created = await createTenantUser(q, {
          email: body.email,
          name: body.name,
          passwordHash,
          tenantId: id.data,
          tenantRole: firstUser ? "admin" : "member",
        });
        await recordAudit(q, {
          actorUserId: principal.userId,
          action: "user.created",
          tenantId: id.data,
          targetUserId: created.id,
          metadata: { email: created.email },
        });
        return created;
      });
      if (user === null) throw notFound("Tenant not found");

      res.status(201).json({
        user: serializeUser(user),
        ...(generated ? { temporaryPassword: generated } : {}),
      });
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw conflict(`A user with email "${body.email}" already exists`);
      }
      throw err;
    }
  });

  router.post("/users/:id/disable", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("User not found");
    noBody.parse(req.body ?? {});

    const existing = await db.withContext(principal, (q) => getUserById(q, id.data));
    if (!existing) throw notFound("User not found");
    if (existing.role === "admin") throw badRequest("Platform admin accounts cannot be disabled here");
    if (existing.disabled_at) throw conflict("User is already disabled");

    const user = await db.withContext(principal, async (q) => {
      const row = await disableUser(q, id.data);
      if (!row) return null;
      await recordAudit(q, {
        actorUserId: principal.userId,
        action: "user.disabled",
        tenantId: row.tenant_id,
        targetUserId: row.id,
        metadata: { email: row.email },
      });
      return row;
    });
    if (!user) throw notFound("User not found");
    res.json({ user: serializeUser(user) });
  });

  router.post("/users/:id/enable", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("User not found");
    noBody.parse(req.body ?? {});

    const existing = await db.withContext(principal, (q) => getUserById(q, id.data));
    if (!existing) throw notFound("User not found");
    if (!existing.disabled_at) throw conflict("User is not disabled");

    const user = await db.withContext(principal, async (q) => {
      // enableUser clears disabled_at only — tenant_id and role are untouched.
      const row = await enableUser(q, id.data);
      if (!row) return null;
      await recordAudit(q, {
        actorUserId: principal.userId,
        action: "user.enabled",
        tenantId: row.tenant_id,
        targetUserId: row.id,
        metadata: { email: row.email },
      });
      return row;
    });
    if (!user) throw notFound("User not found");
    res.json({ user: serializeUser(user) });
  });

  router.get("/users", async (req, res) => {
    const principal = requireAuth(req);
    const rows = await db.withContext(principal, (q) => listUsers(q));
    res.json({ users: rows.map(serializeUser) });
  });

  // --- Audit log ------------------------------------------------------

  router.get("/audit-logs", async (req, res) => {
    const principal = requireAuth(req);
    const opts = auditQuery.parse(req.query);
    const rows = await db.withContext(principal, (q) => listAuditLogs(q, opts));
    res.json({ auditLogs: rows.map(serializeAuditLog) });
  });

  return router;
}
