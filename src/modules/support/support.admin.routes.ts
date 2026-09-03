import { type Request, type Response, Router } from "express";
import { z } from "zod";
import { authenticate, requireAdmin, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { conflict, notFound } from "../../http/errors.ts";
import { recordAudit } from "../admin/audit.ts";
import {
  addMessage,
  getTicket,
  getTicketMessages,
  listAllTickets,
  markRead,
  serializeMessage,
  serializeTicket,
  setTicketStatus,
  supportSummaryAdmin,
} from "./support.repo.ts";

const idParam = z.string().uuid();
const listQuery = z.object({ status: z.enum(["open", "closed"]).optional() });
const messageSchema = z.object({ body: z.string().trim().min(1).max(4000) }).strict();
const noBody = z.object({}).strict();

/** Admin Control Centre — support desk. */
export function supportAdminRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireAdmin);

  router.get("/summary", async (req, res) => {
    const p = requireAuth(req);
    res.json(await db.withContext(p, (q) => supportSummaryAdmin(q)));
  });

  router.get("/tickets", async (req, res) => {
    const p = requireAuth(req);
    const { status } = listQuery.parse(req.query);
    const rows = await db.withContext(p, (q) => listAllTickets(q, { status }));
    res.json({ tickets: rows.map(serializeTicket) });
  });

  router.get("/tickets/:id", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Ticket not found");
    const result = await db.withContext(p, async (q) => {
      const ticket = await getTicket(q, id.data);
      if (!ticket) return null;
      const messages = await getTicketMessages(q, id.data);
      await markRead(q, id.data, "admin");
      return { ticket, messages };
    });
    if (!result) throw notFound("Ticket not found");
    res.json({
      ticket: serializeTicket(result.ticket),
      messages: result.messages.map(serializeMessage),
    });
  });

  router.post("/tickets/:id/messages", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Ticket not found");
    const body = messageSchema.parse(req.body);
    const outcome = await db.withContext(p, async (q) => {
      const ticket = await getTicket(q, id.data);
      if (!ticket) return "not_found";
      if (ticket.status === "closed") return "closed";
      const msg = await addMessage(q, {
        ticketId: id.data,
        authorUserId: p.userId,
        authorKind: "admin",
        body: body.body,
      });
      return msg ? { msg } : "not_found";
    });
    if (outcome === "not_found") throw notFound("Ticket not found");
    if (outcome === "closed") throw conflict("Reopen the ticket before replying");
    res.status(201).json({ message: serializeMessage(outcome.msg) });
  });

  const setStatus = (status: "open" | "closed") => async (req: Request, res: Response) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Ticket not found");
    noBody.parse(req.body ?? {});
    const ticket = await db.withContext(p, async (q) => {
      const row = await setTicketStatus(q, id.data, status, p.userId);
      if (!row) return null;
      await recordAudit(q, {
        actorUserId: p.userId,
        action: status === "closed" ? "support.ticket_closed" : "support.ticket_reopened",
        tenantId: row.tenant_id,
        metadata: { ticketId: row.id, subject: row.subject },
      });
      return row;
    });
    if (!ticket) throw conflict(`Ticket is already ${status === "closed" ? "closed" : "open"}, or not found`);
    res.json({ ticket: serializeTicket(ticket) });
  };

  router.post("/tickets/:id/close", setStatus("closed"));
  router.post("/tickets/:id/reopen", setStatus("open"));

  return router;
}
