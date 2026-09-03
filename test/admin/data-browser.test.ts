import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Admin "Data" browser — read-only, platform-admin only, cross-tenant. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const admin = () => auth(h.tokens.admin);

describe("access control", () => {
  it("is platform-admin only", async () => {
    for (const path of ["/api/admin/data/overview", `/api/admin/data/tenants/${h.ids.tenants.acme}`]) {
      expect((await h.api.get(path)).status, path).toBe(401);
      expect((await h.api.get(path).set(...auth(h.tokens.alice))).status, path).toBe(403);
      expect((await h.api.get(path).set(...admin())).status, path).toBe(200);
    }
  });
});

describe("overview", () => {
  it("summarises every tenant with counts", async () => {
    const res = await h.api.get("/api/admin/data/overview").set(...admin());
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ tenants: 2, users: expect.any(Number) });
    const acme = res.body.tenants.find((t: any) => t.slug === "acme");
    expect(acme).toMatchObject({ name: "Acme Ltd", status: "active" });
    expect(typeof acme.customers).toBe("number");
  });
});

describe("tenant bundle", () => {
  it("shows what a tenant has created, scoped to that tenant", async () => {
    // Alice adds a customer in Acme.
    const created = await h.api
      .post("/api/customers")
      .set(...auth(h.tokens.alice))
      .send({ name: "Contoso", email: "ap@contoso.example", city: "Cork" });
    expect(created.status).toBe(201);

    const acme = await h.api.get(`/api/admin/data/tenants/${h.ids.tenants.acme}`).set(...admin());
    expect(acme.status).toBe(200);
    expect(acme.body.tenant.slug).toBe("acme");
    expect(acme.body.customers.map((c: any) => c.name)).toContain("Contoso");
    expect(acme.body.users.map((u: any) => u.email)).toContain("alice@acme.test");

    // Smith's bundle must not contain Acme's customer.
    const smith = await h.api.get(`/api/admin/data/tenants/${h.ids.tenants.smith}`).set(...admin());
    expect(smith.body.customers.map((c: any) => c.name)).not.toContain("Contoso");
  });

  it("404s for an unknown tenant id", async () => {
    const res = await h.api
      .get("/api/admin/data/tenants/00000000-0000-0000-0000-000000000000")
      .set(...admin());
    expect(res.status).toBe(404);
  });
});
