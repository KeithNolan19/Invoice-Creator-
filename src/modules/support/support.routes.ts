import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth, requireTenantUser } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { conflict, notFound } from "../../http/errors.ts";
import {
  addMessage,
  createTicket,
  getTicket,
  getTicketMessages,
  listTicketsForTenant,
  markRead,
  serializeMessage,
  serializeTicket,
  supportSummaryTenant,
} from "./support.repo.ts";

const idParam = z.string().uuid();
const openSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    message: z.string().trim().min(1).max(4000),
  })
  .strict();
const messageSchema = z.object({ body: z.string().trim().min(1).max(4000) }).strict();

/** Customer-app support chat. Any tenant user of the tenant. */
export function supportRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireTenantUser);

  router.get("/summary", async (req, res) => {
    const p = requireAuth(req);
    res.json(await db.withContext(p, (q) => supportSummaryTenant(q)));
  });

  router.get("/tickets", async (req, res) => {
    const p = requireAuth(req);
    const rows = await db.withContext(p, (q) => listTicketsForTenant(q));
    res.json({ tickets: rows.map(serializeTicket) });
  });

  router.post("/tickets", async (req, res) => {
    const p = requireAuth(req);
    const body = openSchema.parse(req.body);
    const ticket = await db.withContext(p, (q) =>
      createTicket(q, {
        tenantId: p.tenantId!,
        subject: body.subject,
        openedBy: p.userId,
        firstMessage: body.message,
      }),
    );
    res.status(201).json({ ticket: serializeTicket(ticket) });
  });

  router.get("/tickets/:id", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Ticket not found");
    const result = await db.withContext(p, async (q) => {
      const ticket = await getTicket(q, id.data);
      if (!ticket) return null;
      const messages = await getTicketMessages(q, id.data);
      await markRead(q, id.data, "tenant");
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
        authorKind: "tenant",
        body: body.body,
      });
      return msg ? { msg } : "not_found";
    });
    if (outcome === "not_found") throw notFound("Ticket not found");
    if (outcome === "closed") throw conflict("This ticket is closed — open a new one");
    res.status(201).json({ message: serializeMessage(outcome.msg) });
  });

  router.post("/tickets/:id/read", async (req, res) => {
    const p = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Ticket not found");
    await db.withContext(p, async (q) => {
      if (!(await getTicket(q, id.data))) throw notFound("Ticket not found");
      await markRead(q, id.data, "tenant");
    });
    res.status(204).end();
  });

  return router;
}
