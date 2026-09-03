import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { badRequest, conflict, notFound } from "../../http/errors.ts";
import { getTenantById } from "../tenants/tenants.repo.ts";
import {
  deleteInvoice,
  getInvoiceById,
  insertInvoice,
  listInvoices,
  serializeInvoice,
  updateInvoice,
} from "./invoices.repo.ts";

const createSchema = z
  .object({
    number: z.string().trim().min(1).max(64),
    clientName: z.string().trim().min(1).max(200),
    amountCents: z.number().int().nonnegative(),
    currency: z.string().trim().length(3).toUpperCase().default("USD"),
    status: z.enum(["draft", "sent", "paid", "void"]).default("draft"),
    dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").nullish(),
    // Only meaningful for admins; ignored for tenant users.
    tenantId: z.string().uuid().optional(),
  })
  .strict();

// No tenantId / number / createdBy here — they are not mutable through the API.
const patchSchema = z
  .object({
    clientName: z.string().trim().min(1).max(200).optional(),
    amountCents: z.number().int().nonnegative().optional(),
    status: z.enum(["draft", "sent", "paid", "void"]).optional(),
    dueOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD").nullish(),
  })
  .strict();

const listQuerySchema = z.object({
  tenantId: z.string().uuid().optional(),
  status: z.enum(["draft", "sent", "paid", "void"]).optional(),
  paymentStatus: z.enum(["unpaid", "pending", "paid"]).optional(),
  overdue: z.enum(["true", "1"]).optional(),
  customerId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
});

export function invoiceRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));

  router.get("/", async (req, res) => {
    const principal = requireAuth(req);
    const query = listQuerySchema.parse(req.query);

    const rows = await db.withContext(principal, (q) =>
      listInvoices(q, {
        // A tenantId filter is honoured only for admins; RLS already restricts
        // everyone else to their own tenant regardless of the query string.
        tenantId: principal.isAdmin ? query.tenantId : null,
        status: query.status,
        paymentStatus: query.paymentStatus,
        overdue: query.overdue !== undefined,
        customerId: query.customerId,
        search: query.search,
      }),
    );
    res.json({ invoices: rows.map(serializeInvoice) });
  });

  router.get("/:id", async (req, res) => {
    const principal = requireAuth(req);
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound("Invoice not found");

    const row = await db.withContext(principal, (q) => getInvoiceById(q, id.data));
    if (!row) throw notFound("Invoice not found");
    res.json({ invoice: serializeInvoice(row) });
  });

  router.post("/", async (req, res) => {
    const principal = requireAuth(req);
    const body = createSchema.parse(req.body);

    let tenantId: string;
    if (principal.isAdmin) {
      if (!body.tenantId) throw badRequest("tenantId is required when creating as an admin");
      tenantId = body.tenantId;
    } else {
      if (body.tenantId && body.tenantId !== principal.tenantId) {
        throw badRequest("Cannot create an invoice for another tenant");
      }
      tenantId = principal.tenantId!;
    }

    try {
      const row = await db.withContext(principal, async (q) => {
        const tenant = await getTenantById(q, tenantId);
        if (!tenant) throw notFound("Tenant not found");
        return insertInvoice(q, {
          tenantId,
          number: body.number,
          clientName: body.clientName,
          amountCents: body.amountCents,
          currency: body.currency,
          status: body.status,
          dueOn: body.dueOn ?? null,
          createdBy: principal.userId,
        });
      });
      res.status(201).json({ invoice: serializeInvoice(row) });
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw conflict(`Invoice number "${body.number}" already exists for this tenant`);
      }
      throw err;
    }
  });

  router.patch("/:id", async (req, res) => {
    const principal = requireAuth(req);
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound("Invoice not found");
    const patch = patchSchema.parse(req.body);

    const row = await db.withContext(principal, (q) =>
      updateInvoice(q, id.data, {
        clientName: patch.clientName,
        amountCents: patch.amountCents,
        status: patch.status,
        dueOn: patch.dueOn === undefined ? undefined : patch.dueOn,
      }),
    );
    // Row not found, or hidden from this caller by RLS — same 404 either way.
    if (!row) throw notFound("Invoice not found");
    res.json({ invoice: serializeInvoice(row) });
  });

  router.delete("/:id", async (req, res) => {
    const principal = requireAuth(req);
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) throw notFound("Invoice not found");

    const deleted = await db.withContext(principal, (q) => deleteInvoice(q, id.data));
    if (!deleted) throw notFound("Invoice not found");
    res.status(204).end();
  });

  return router;
}
