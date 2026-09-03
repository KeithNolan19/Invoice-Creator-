import { Router } from "express";
import { z } from "zod";
import { authenticate, requireAuth, requireTenantUser } from "../../auth/middleware.ts";
import type { Db } from "../../db/types.ts";
import { conflict, notFound } from "../../http/errors.ts";
import { listInvoices, serializeInvoice } from "../invoices/invoices.repo.ts";
import {
  archiveCustomer,
  getCustomerById,
  getCustomerInvoiceStats,
  insertCustomer,
  listCustomers,
  serializeCustomer,
  serializeCustomerListItem,
  serializeCustomerStats,
  updateCustomer,
} from "./customers.repo.ts";

const idParam = z.string().uuid();
const emptyBody = z.object({}).strict();

const nullableStr = (max: number) => z.string().trim().max(max).nullish();

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(200).nullish(),
    addressLine1: nullableStr(200),
    addressLine2: nullableStr(200),
    city: nullableStr(120),
    region: nullableStr(120),
    postalCode: nullableStr(32),
    country: nullableStr(120),
    taxNumber: nullableStr(64),
    notes: nullableStr(2000),
  })
  .strict();

const patchSchema = createSchema.partial().strict();

const listQuery = z.object({
  search: z.string().trim().max(120).optional(),
  includeArchived: z.enum(["true", "1"]).optional(),
});

export function customerRoutes(db: Db): Router {
  const router = Router();
  router.use(authenticate(db));
  router.use(requireTenantUser);

  router.get("/", async (req, res) => {
    const principal = requireAuth(req);
    const { search, includeArchived } = listQuery.parse(req.query);
    const rows = await db.withContext(principal, (q) =>
      listCustomers(q, { search, includeArchived: includeArchived !== undefined }),
    );
    res.json({ customers: rows.map(serializeCustomerListItem) });
  });

  router.post("/", async (req, res) => {
    const principal = requireAuth(req);
    const body = createSchema.parse(req.body);
    try {
      const row = await db.withContext(principal, (q) =>
        insertCustomer(q, principal.tenantId!, principal.userId, {
          name: body.name,
          email: body.email ?? null,
          addressLine1: body.addressLine1 ?? null,
          addressLine2: body.addressLine2 ?? null,
          city: body.city ?? null,
          region: body.region ?? null,
          postalCode: body.postalCode ?? null,
          country: body.country ?? null,
          taxNumber: body.taxNumber ?? null,
          notes: body.notes ?? null,
        }),
      );
      res.status(201).json({ customer: serializeCustomer(row) });
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw conflict("A customer with that email already exists");
      }
      throw err;
    }
  });

  router.get("/:id", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Customer not found");

    const result = await db.withContext(principal, async (q) => {
      const customer = await getCustomerById(q, id.data);
      if (!customer) return null;
      const [invoices, stats] = await Promise.all([
        listInvoices(q, { customerId: id.data }),
        getCustomerInvoiceStats(q, id.data),
      ]);
      return { customer, invoices, stats };
    });
    if (!result) throw notFound("Customer not found");

    res.json({
      customer: serializeCustomer(result.customer),
      invoices: result.invoices.map(serializeInvoice),
      stats: serializeCustomerStats(result.stats),
    });
  });

  router.patch("/:id", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Customer not found");
    const body = patchSchema.parse(req.body);
    try {
      const row = await db.withContext(principal, (q) => updateCustomer(q, id.data, body));
      if (!row) throw notFound("Customer not found");
      res.json({ customer: serializeCustomer(row) });
    } catch (err) {
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw conflict("A customer with that email already exists");
      }
      throw err;
    }
  });

  router.post("/:id/archive", async (req, res) => {
    const principal = requireAuth(req);
    const id = idParam.safeParse(req.params.id);
    if (!id.success) throw notFound("Customer not found");
    emptyBody.parse(req.body ?? {});

    const existing = await db.withContext(principal, (q) => getCustomerById(q, id.data));
    if (!existing) throw notFound("Customer not found");
    if (existing.archived_at) throw conflict("Customer is already archived");

    const row = await db.withContext(principal, (q) => archiveCustomer(q, id.data));
    if (!row) throw notFound("Customer not found");
    res.json({ customer: serializeCustomer(row) });
  });

  return router;
}
