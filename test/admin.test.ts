import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "./support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe("admin cross-tenant access", () => {
  it("sees invoices from every tenant", async () => {
    const res = await h.api.get("/api/invoices").set(...auth(h.tokens.admin));
    expect(res.status).toBe(200);

    const tenantIds = new Set(res.body.invoices.map((i: any) => i.tenantId));
    expect(tenantIds.has(h.ids.tenants.acme)).toBe(true);
    expect(tenantIds.has(h.ids.tenants.smith)).toBe(true);
    expect(res.body.invoices.length).toBe(
      h.ids.invoices.acme.length + h.ids.invoices.smith.length,
    );
  });

  it("can filter by tenantId", async () => {
    const res = await h.api
      .get(`/api/invoices?tenantId=${h.ids.tenants.smith}`)
      .set(...auth(h.tokens.admin));
    expect(res.status).toBe(200);
    expect(res.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.smith)).toBe(true);
    expect(res.body.invoices.length).toBe(h.ids.invoices.smith.length);
  });

  it("can fetch a specific invoice from any tenant", async () => {
    for (const id of [h.ids.invoices.acme[0]!, h.ids.invoices.smith[0]!]) {
      const res = await h.api.get(`/api/invoices/${id}`).set(...auth(h.tokens.admin));
      expect(res.status).toBe(200);
      expect(res.body.invoice.id).toBe(id);
    }
  });

  it("lists every tenant", async () => {
    const res = await h.api.get("/api/tenants").set(...auth(h.tokens.admin));
    expect(res.status).toBe(200);
    expect(res.body.tenants.map((t: any) => t.slug).sort()).toEqual(["acme", "smith"]);
  });

  it("requires an explicit tenantId when creating an invoice", async () => {
    const missing = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.admin))
      .send({ number: "ADM-1", clientName: "C", amountCents: 10 });
    expect(missing.status).toBe(400);

    const ok = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.admin))
      .send({ number: "ADM-1", clientName: "C", amountCents: 10, tenantId: h.ids.tenants.smith });
    expect(ok.status).toBe(201);
    expect(ok.body.invoice.tenantId).toBe(h.ids.tenants.smith);

    // Bob (Smith) should now see it; Alice (Acme) should not.
    const bob = await h.api.get("/api/invoices").set(...auth(h.tokens.bob));
    expect(bob.body.invoices.some((i: any) => i.number === "ADM-1")).toBe(true);
    const alice = await h.api.get("/api/invoices").set(...auth(h.tokens.alice));
    expect(alice.body.invoices.some((i: any) => i.number === "ADM-1")).toBe(false);
  });
});

describe("tenant user cannot use admin surface", () => {
  it("only sees its own tenant from /api/tenants", async () => {
    const res = await h.api.get("/api/tenants").set(...auth(h.tokens.alice));
    expect(res.status).toBe(200);
    expect(res.body.tenants.map((t: any) => t.slug)).toEqual(["acme"]);
  });
});
