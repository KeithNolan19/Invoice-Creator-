import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Stage 2 — customer management API. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const mk = (token: string, body: object) =>
  h.api.post("/api/customers").set(...auth(token)).send(body);

describe("customer CRUD (any tenant user)", () => {
  it("a member and an admin can both create, read, update and archive customers", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });

    const created = await mk(carol.token, { name: "Globex", email: "AP@Globex.test", city: "Dublin", country: "IE" });
    expect(created.status).toBe(201);
    expect(created.body.customer).toMatchObject({ name: "Globex", email: "ap@globex.test" });
    expect(created.body.customer.address).toMatchObject({ city: "Dublin", country: "IE" });
    const id = created.body.customer.id;

    const list = await h.api.get("/api/customers").set(...auth(h.tokens.alice));
    expect(list.body.customers.map((c: any) => c.name)).toEqual(["Globex"]);
    expect(list.body.customers[0].invoiceCount).toBe(0);

    const detail = await h.api.get(`/api/customers/${id}`).set(...auth(carol.token));
    expect(detail.status).toBe(200);
    expect(detail.body.invoices).toEqual([]);
    expect(detail.body.stats).toMatchObject({ invoiceCount: 0, totalCents: 0, outstandingCents: 0 });

    const patched = await h.api.patch(`/api/customers/${id}`).set(...auth(h.tokens.alice)).send({ notes: "Net 30", email: null });
    expect(patched.body.customer.notes).toBe("Net 30");
    expect(patched.body.customer.email).toBeNull();

    const archived = await h.api.post(`/api/customers/${id}/archive`).set(...auth(carol.token));
    expect(archived.status).toBe(200);
    expect(archived.body.customer.archived).toBe(true);

    const activeList = await h.api.get("/api/customers").set(...auth(h.tokens.alice));
    expect(activeList.body.customers).toEqual([]);
    const withArchived = await h.api.get("/api/customers?includeArchived=true").set(...auth(h.tokens.alice));
    expect(withArchived.body.customers).toHaveLength(1);

    const archiveAgain = await h.api.post(`/api/customers/${id}/archive`).set(...auth(h.tokens.alice));
    expect(archiveAgain.status).toBe(409);
  });

  it("validates input strictly and rejects unknown / oversized fields", async () => {
    expect((await mk(h.tokens.alice, {})).status).toBe(400);
    expect((await mk(h.tokens.alice, { name: "" })).status).toBe(400);
    expect((await mk(h.tokens.alice, { name: "X", email: "not-an-email" })).status).toBe(400);
    expect((await mk(h.tokens.alice, { name: "X", tenantId: h.ids.tenants.smith })).status).toBe(400);
    expect((await mk(h.tokens.alice, { name: "X", role: "admin" })).status).toBe(400);
  });

  it("rejects a duplicate email within the tenant, but the same email is free in another tenant", async () => {
    expect((await mk(h.tokens.alice, { name: "A", email: "dup@x.test" })).status).toBe(201);
    expect((await mk(h.tokens.alice, { name: "B", email: "dup@x.test" })).status).toBe(409);
    expect((await mk(h.tokens.bob, { name: "C", email: "dup@x.test" })).status).toBe(201);
  });

  it("search matches name or email", async () => {
    await mk(h.tokens.alice, { name: "Wayne Enterprises", email: "billing@wayne.test" });
    await mk(h.tokens.alice, { name: "Stark Industries", email: "ap@stark.test" });
    const byName = await h.api.get("/api/customers?search=stark").set(...auth(h.tokens.alice));
    expect(byName.body.customers.map((c: any) => c.name)).toEqual(["Stark Industries"]);
    const byEmail = await h.api.get("/api/customers?search=wayne.test").set(...auth(h.tokens.alice));
    expect(byEmail.body.customers.map((c: any) => c.name)).toEqual(["Wayne Enterprises"]);
  });
});

describe("tenant isolation", () => {
  it("Tenant A cannot list, read, edit or archive Tenant B customers", async () => {
    const smithCustomer = (await mk(h.tokens.bob, { name: "Smith Only" })).body.customer.id;

    const acmeList = await h.api.get("/api/customers").set(...auth(h.tokens.alice));
    expect(acmeList.body.customers.some((c: any) => c.id === smithCustomer)).toBe(false);

    expect((await h.api.get(`/api/customers/${smithCustomer}`).set(...auth(h.tokens.alice))).status).toBe(404);
    expect((await h.api.patch(`/api/customers/${smithCustomer}`).set(...auth(h.tokens.alice)).send({ name: "PWNED" })).status).toBe(404);
    expect((await h.api.post(`/api/customers/${smithCustomer}/archive`).set(...auth(h.tokens.alice))).status).toBe(404);

    const check = await h.api.get(`/api/customers/${smithCustomer}`).set(...auth(h.tokens.bob));
    expect(check.body.customer.name).toBe("Smith Only");
  });

  it("holds directly at the database layer", async () => {
    const acmeId = (await mk(h.tokens.alice, { name: "DB Acme" })).body.customer.id;
    const rows = await h.db.withContext(
      { userId: h.ids.users.bob, tenantId: h.ids.tenants.smith, isAdmin: false, tenantRole: "admin" },
      (q) => q.query("SELECT id FROM customers WHERE id = $1", [acmeId]),
    );
    expect(rows.rows).toEqual([]);
  });
});

describe("access control", () => {
  it("unauthenticated -> 401", async () => {
    expect((await h.api.get("/api/customers")).status).toBe(401);
    expect((await h.api.post("/api/customers").send({ name: "X" })).status).toBe(401);
  });

  it("a platform admin is refused (they use the Admin Control Centre)", async () => {
    expect((await h.api.get("/api/customers").set(...auth(h.tokens.admin))).status).toBe(403);
    expect((await h.api.post("/api/customers").set(...auth(h.tokens.admin)).send({ name: "X" })).status).toBe(403);
  });

  it("a disabled user and a suspended tenant are blocked", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    await h.api.post(`/api/admin/users/${carol.id}/disable`).set(...auth(h.tokens.admin));
    expect((await h.api.get("/api/customers").set(...auth(carol.token))).status).toBe(403);

    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...auth(h.tokens.admin));
    expect((await h.api.get("/api/customers").set(...auth(h.tokens.alice))).status).toBe(403);
  });
});
