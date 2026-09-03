import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";
import { forgedClaimsToken } from "./helpers.ts";

/**
 * Requirement 6 — data-driven authorization matrix.
 *
 * Actors:  unauthenticated · Acme user · Smith user · disabled user ·
 *          suspended-tenant user · platform admin · forged-JWT-claims user
 *
 * Every admin endpoint is exercised for every actor. Normal endpoints are
 * exercised for the tenant actors including manipulated IDs / query params /
 * body fields.
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const admin = () => auth(h.tokens.admin);

interface Endpoint {
  name: string;
  method: "get" | "post" | "patch" | "delete";
  path: () => string;
  body?: () => unknown;
}

/** Every /api/admin/* route. */
const adminEndpoints = (): Endpoint[] => [
  { name: "GET /admin/dashboard", method: "get", path: () => "/api/admin/dashboard" },
  { name: "GET /admin/tenants", method: "get", path: () => "/api/admin/tenants" },
  { name: "POST /admin/tenants", method: "post", path: () => "/api/admin/tenants", body: () => ({ name: "Matrix Co" }) },
  { name: "GET /admin/tenants/:id", method: "get", path: () => `/api/admin/tenants/${h.ids.tenants.acme}` },
  { name: "POST /admin/tenants/:id/suspend", method: "post", path: () => `/api/admin/tenants/${h.ids.tenants.smith}/suspend` },
  { name: "POST /admin/tenants/:id/reactivate", method: "post", path: () => `/api/admin/tenants/${h.ids.tenants.acme}/reactivate` },
  { name: "GET /admin/tenants/:id/users", method: "get", path: () => `/api/admin/tenants/${h.ids.tenants.acme}/users` },
  { name: "POST /admin/tenants/:id/users", method: "post", path: () => `/api/admin/tenants/${h.ids.tenants.acme}/users`, body: () => ({ name: "M", email: "m@acme.test" }) },
  { name: "POST /admin/users/:id/disable", method: "post", path: () => `/api/admin/users/${h.ids.users.bob}/disable` },
  { name: "POST /admin/users/:id/enable", method: "post", path: () => `/api/admin/users/${h.ids.users.bob}/enable` },
  { name: "GET /admin/users", method: "get", path: () => "/api/admin/users" },
  { name: "GET /admin/audit-logs", method: "get", path: () => "/api/admin/audit-logs" },
];

/** Normal authenticated endpoints. */
const normalEndpoints = (): Endpoint[] => [
  { name: "GET /auth/me", method: "get", path: () => "/api/auth/me" },
  { name: "POST /auth/logout", method: "post", path: () => "/api/auth/logout" },
  { name: "GET /tenants", method: "get", path: () => "/api/tenants" },
  { name: "GET /users", method: "get", path: () => "/api/users" },
  { name: "GET /invoices", method: "get", path: () => "/api/invoices" },
];

function send(ep: Endpoint, token?: string) {
  let r = h.api[ep.method](ep.path());
  if (token) r = r.set(...auth(token));
  if (ep.body) r = r.send(ep.body() as object);
  return r;
}

describe("unauthenticated", () => {
  it("every admin endpoint returns 401", async () => {
    for (const ep of adminEndpoints()) {
      expect((await send(ep)).status, ep.name).toBe(401);
    }
  });
  it("every normal authenticated endpoint returns 401", async () => {
    for (const ep of normalEndpoints()) {
      expect((await send(ep)).status, ep.name).toBe(401);
    }
    for (const p of ["/api/invoices", `/api/invoices/${h.ids.invoices.acme[0]}`]) {
      expect((await h.api.get(p)).status, p).toBe(401);
    }
  });
});

describe.each([
  { label: "Acme user", tok: () => h.tokens.alice, own: "acme" as const, other: "smith" as const },
  { label: "Smith user", tok: () => h.tokens.bob, own: "smith" as const, other: "acme" as const },
])("$label", ({ tok, own, other }) => {
  it("is refused (403) by every admin endpoint", async () => {
    for (const ep of adminEndpoints()) {
      expect((await send(ep, tok())).status, ep.name).toBe(403);
    }
  });

  it("reads only its own tenant across tenants/users/invoices", async () => {
    const t = await h.api.get("/api/tenants").set(...auth(tok()));
    expect(t.body.tenants.every((x: any) => x.id === h.ids.tenants[own])).toBe(true);
    const u = await h.api.get("/api/users").set(...auth(tok()));
    expect(u.body.users.every((x: any) => x.tenantId === h.ids.tenants[own])).toBe(true);
    const i = await h.api.get("/api/invoices").set(...auth(tok()));
    expect(i.body.invoices.every((x: any) => x.tenantId === h.ids.tenants[own])).toBe(true);
  });

  it("cannot reach the other tenant by id / query param / body", async () => {
    const victim = h.ids.invoices[other][0]!;
    expect((await h.api.get(`/api/invoices/${victim}`).set(...auth(tok()))).status).toBe(404);
    expect((await h.api.get(`/api/invoices/${victim}?tenantId=${h.ids.tenants[own]}`).set(...auth(tok()))).status).toBe(404);
    expect((await h.api.patch(`/api/invoices/${victim}`).set(...auth(tok())).send({ clientName: "x" })).status).toBe(404);
    expect((await h.api.delete(`/api/invoices/${victim}`).set(...auth(tok()))).status).toBe(404);

    const list = await h.api.get(`/api/invoices?tenantId=${h.ids.tenants[other]}`).set(...auth(tok()));
    expect(list.body.invoices.every((x: any) => x.tenantId === h.ids.tenants[own])).toBe(true);

    const spoof = await h.api
      .post("/api/invoices")
      .set(...auth(tok()))
      .send({ number: "MX-1", clientName: "x", amountCents: 1, tenantId: h.ids.tenants[other] });
    expect(spoof.status).toBe(400);
  });
});

describe("disabled user", () => {
  beforeEach(async () => {
    await h.api.post(`/api/admin/users/${h.ids.users.bob}/disable`).set(...admin());
  });

  it("is 403 on every authenticated endpoint (normal + admin)", async () => {
    for (const ep of [...normalEndpoints(), ...adminEndpoints()]) {
      const status = (await send(ep, h.tokens.bob)).status;
      expect(status, ep.name).toBe(403);
    }
  });

  it("cannot obtain a new token", async () => {
    const res = await h.api.post("/api/auth/login").send({ email: "bob@smith.test", password: "Password123!" });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("account_disabled");
  });

  it("does not affect the other tenant", async () => {
    expect((await h.api.get("/api/invoices").set(...auth(h.tokens.alice))).status).toBe(200);
  });
});

describe("suspended-tenant user", () => {
  beforeEach(async () => {
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...admin());
  });

  it("Alice is 403 on every authenticated endpoint", async () => {
    for (const ep of [...normalEndpoints(), ...adminEndpoints()]) {
      expect((await send(ep, h.tokens.alice)).status, ep.name).toBe(403);
    }
    const login = await h.api.post("/api/auth/login").send({ email: "alice@acme.test", password: "Password123!" });
    expect(login.status).toBe(403);
    expect(login.body.error.code).toBe("tenant_suspended");
  });

  it("Smith is entirely unaffected", async () => {
    expect((await h.api.get("/api/invoices").set(...auth(h.tokens.bob))).status).toBe(200);
    expect((await h.api.get("/api/auth/me").set(...auth(h.tokens.bob))).status).toBe(200);
  });

  it("the platform admin still manages the suspended tenant", async () => {
    expect((await h.api.get(`/api/admin/tenants/${h.ids.tenants.acme}`).set(...admin())).status).toBe(200);
    expect((await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/reactivate`).set(...admin())).status).toBe(200);
  });
});

describe("platform admin", () => {
  it("passes the gate on every admin endpoint (never 401/403)", async () => {
    for (const ep of adminEndpoints()) {
      const status = (await send(ep, h.tokens.admin)).status;
      expect([401, 403], `${ep.name} -> ${status}`).not.toContain(status);
    }
  });

  it("sees data from both tenants", async () => {
    const inv = await h.api.get("/api/invoices").set(...admin());
    const tenants = new Set(inv.body.invoices.map((i: any) => i.tenantId));
    expect(tenants.has(h.ids.tenants.acme) && tenants.has(h.ids.tenants.smith)).toBe(true);
  });
});

describe("forged JWT claims", () => {
  const forged = () =>
    forgedClaimsToken(h.ids.users.alice, {
      role: "admin",
      isAdmin: true,
      admin: true,
      tenantId: h.ids.tenants.smith,
      tid: h.ids.tenants.smith,
      permissions: ["*"],
    });

  it("is still just the Acme tenant user — 403 on every admin endpoint", async () => {
    for (const ep of adminEndpoints()) {
      expect((await send(ep, forged())).status, ep.name).toBe(403);
    }
  });

  it("is scoped to Acme on normal endpoints regardless of the claimed tenant", async () => {
    const me = await h.api.get("/api/auth/me").set(...auth(forged()));
    expect(me.body.user.role).toBe("user");
    expect(me.body.user.tenantId).toBe(h.ids.tenants.acme);

    const inv = await h.api.get("/api/invoices").set(...auth(forged()));
    expect(inv.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.acme)).toBe(true);
  });
});
