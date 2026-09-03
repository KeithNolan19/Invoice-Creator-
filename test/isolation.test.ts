import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "./support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe("tenant isolation (tenant users)", () => {
  it("lists only the caller's own tenant invoices", async () => {
    const acme = await h.api.get("/api/invoices").set(...auth(h.tokens.alice));
    expect(acme.status).toBe(200);
    expect(acme.body.invoices.length).toBe(h.ids.invoices.acme.length);
    expect(acme.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.acme)).toBe(true);

    const smith = await h.api.get("/api/invoices").set(...auth(h.tokens.bob));
    expect(smith.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.smith)).toBe(true);

    const acmeIds = new Set(acme.body.invoices.map((i: any) => i.id));
    const smithIds = new Set(smith.body.invoices.map((i: any) => i.id));
    expect([...acmeIds].some((id) => smithIds.has(id))).toBe(false);
  });

  it("returns 404 (not 403) when fetching another tenant's invoice by id", async () => {
    const smithInvoiceId = h.ids.invoices.smith[0]!;
    const res = await h.api
      .get(`/api/invoices/${smithInvoiceId}`)
      .set(...auth(h.tokens.alice));
    expect(res.status).toBe(404);
  });

  it("can fetch its own invoice by id", async () => {
    const own = h.ids.invoices.acme[0]!;
    const res = await h.api.get(`/api/invoices/${own}`).set(...auth(h.tokens.alice));
    expect(res.status).toBe(200);
    expect(res.body.invoice.id).toBe(own);
  });

  it("ignores a query-string tenantId filter for tenant users", async () => {
    const res = await h.api
      .get(`/api/invoices?tenantId=${h.ids.tenants.smith}`)
      .set(...auth(h.tokens.alice));
    expect(res.status).toBe(200);
    expect(res.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.acme)).toBe(true);
  });

  it("stamps new invoices with the caller's tenant and rejects a spoofed tenantId", async () => {
    const created = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.alice))
      .send({ number: "ACME-NEW-1", clientName: "New Client", amountCents: 5000 });
    expect(created.status).toBe(201);
    expect(created.body.invoice.tenantId).toBe(h.ids.tenants.acme);

    const spoof = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.alice))
      .send({
        number: "ACME-NEW-2",
        clientName: "X",
        amountCents: 1,
        tenantId: h.ids.tenants.smith,
      });
    expect(spoof.status).toBe(400);

    // The spoofed invoice must not exist for either tenant.
    const bobList = await h.api.get("/api/invoices").set(...auth(h.tokens.bob));
    expect(bobList.body.invoices.some((i: any) => i.number === "ACME-NEW-2")).toBe(false);
  });

  it("enforces per-tenant unique invoice numbers without leaking across tenants", async () => {
    // Both tenants can independently use the same invoice number.
    const a = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.alice))
      .send({ number: "SHARED-1", clientName: "A", amountCents: 100 });
    const b = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.bob))
      .send({ number: "SHARED-1", clientName: "B", amountCents: 200 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    // ...but a duplicate within the same tenant is a 409.
    const dup = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.alice))
      .send({ number: "SHARED-1", clientName: "A2", amountCents: 300 });
    expect(dup.status).toBe(409);
  });
});
