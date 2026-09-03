import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAdmin, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { notFound } from "../../http/errors.ts";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  serializeNotification,
  unreadCount,
} from "./notifications.repo.ts";

const listQuery = z.object({
  unread: z.enum(["true", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const idParam = z.string().uuid();

/** The admin notification centre. */
export function notificationsAdminRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireAdmin);

  router.get("/", async (req, res) => {
    const p = requireAuth(req);
    const q = listQuery.parse(req.query);
    const rows = await db.withContext(p, (qq) =>
      listNotifications(qq, { unreadOnly: Boolean(q.unread), limit: q.limit }),
    );
    res.json({ notifications: rows.map(serializeNotification) });
  });

  router.get("/unread-count", async (req, res) => {
    const p = requireAuth(req);
    res.json({ count: await db.withContext(p, (qq) => unreadCount(qq)) });
  });

  router.post("/:id/read", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Notification not found");
    const ok = await db.withContext(p, (qq) => markNotificationRead(qq, id.data));
    if (!ok) throw notFound("Notification not found");
    res.status(204).end();
  });

  router.post("/read-all", async (req, res) => {
    const p = requireAuth(req);
    const n = await db.withContext(p, (qq) => markAllNotificationsRead(qq));
    res.json({ marked: n });
  });

  return router;
}
