import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RlsContext } from "../../src/db/types.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/**
 * Security guarantees for the Admin Control Centre:
 *  - every admin endpoint is behind requireAdmin (403 for tenant users, 401 anon)
 *  - browser-supplied tenant_id / role / admin flags are never trusted
 *  - tenant isolation still holds after admin operations
 *  - suspending a tenant / disabling a user actually revokes access
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

interface Ep {
  method: "get" | "post";
  path: () => string;
}
const endpoints = (): Ep[] => [
  { method: "get", path: () => "/api/admin/dashboard" },
  { method: "get", path: () => "/api/admin/tenants" },
  { method: "post", path: () => "/api/admin/tenants" },
  { method: "get", path: () => `/api/admin/tenants/${h.ids.tenants.acme}` },
  { method: "post", path: () => `/api/admin/tenants/${h.ids.tenants.acme}/suspend` },
  { method: "post", path: () => `/api/admin/tenants/${h.ids.tenants.acme}/reactivate` },
  { method: "get", path: () => `/api/admin/tenants/${h.ids.tenants.acme}/users` },
  { method: "post", path: () => `/api/admin/tenants/${h.ids.tenants.acme}/users` },
  { method: "post", path: () => `/api/admin/users/${h.ids.users.alice}/disable` },
  { method: "post", path: () => `/api/admin/users/${h.ids.users.alice}/enable` },
  { method: "get", path: () => "/api/admin/users" },
  { method: "get", path: () => "/api/admin/audit-logs" },
];

describe("every admin endpoint is gated", () => {
  it("returns 401 without a token", async () => {
    for (const ep of endpoints()) {
      const res = await h.api[ep.method](ep.path());
      expect(res.status, ep.path()).toBe(401);
    }
  });

  it("returns 403 for an Acme tenant user", async () => {
    for (const ep of endpoints()) {
      const res = await h.api[ep.method](ep.path()).set(...auth(h.tokens.alice));
      expect(res.status, ep.path()).toBe(403);
    }
  });

  it("returns 403 for a Smith tenant user", async () => {
    for (const ep of endpoints()) {
      const res = await h.api[ep.method](ep.path()).set(...auth(h.tokens.bob));
      expect(res.status, ep.path()).toBe(403);
    }
  });

  it("a tenant user cannot escalate with forged admin claims in the JWT", async () => {
    // signed with the real secret but stuffed with role/admin claims
    const jwt = await import("jsonwebtoken");
    const { config } = await import("../../src/config.ts");
    const token = jwt.default.sign(
      { role: "admin", isAdmin: true, admin: true },
      config.jwt.secret,
      { subject: h.ids.users.alice, expiresIn: "1h" },
    );
    for (const ep of endpoints()) {
      const res = await h.api[ep.method](ep.path()).set(...auth(token));
      expect(res.status, ep.path()).toBe(403);
    }
  });

  it("no admin write leaks through to tenant users' surfaces", async () => {
    // tenant user hitting the *non-admin* API can never reach admin verbs
    const create = await h.api.post("/api/tenants").set(...auth(h.tokens.alice)).send({ name: "x", slug: "x" });
    expect([403, 404]).toContain(create.status);
  });
});

describe("admin can manage both tenants; isolation survives", () => {
  it("a user created in Smith is invisible to Acme and visible to Smith", async () => {
    const created = await h.api
      .post(`/api/admin/tenants/${h.ids.tenants.smith}/users`)
      .set(...auth(h.tokens.admin))
      .send({ name: "New Smith User", email: "newbie@smith.test" });
    expect(created.status).toBe(201);
    const newId = created.body.user.id;

    const acmeUsers = await h.api.get("/api/users").set(...auth(h.tokens.alice));
    expect(acmeUsers.body.users.some((u: any) => u.id === newId)).toBe(false);

    const smithUsers = await h.api.get("/api/users").set(...auth(h.tokens.bob));
    expect(smithUsers.body.users.some((u: any) => u.id === newId)).toBe(true);

    // and the Acme user still cannot see any Smith invoice
    for (const id of h.ids.invoices.smith) {
      expect((await h.api.get(`/api/invoices/${id}`).set(...auth(h.tokens.alice))).status).toBe(404);
    }
  });

  it("admin edits in one tenant never bleed into the other", async () => {
    const invAcme = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.admin))
      .send({ number: "ADM-A", clientName: "A", amountCents: 1, tenantId: h.ids.tenants.acme });
    const invSmith = await h.api
      .post("/api/invoices")
      .set(...auth(h.tokens.admin))
      .send({ number: "ADM-S", clientName: "S", amountCents: 1, tenantId: h.ids.tenants.smith });

    // Bob (Smith) sees only the Smith one
    const bobList = await h.api.get("/api/invoices").set(...auth(h.tokens.bob));
    const bobNumbers = bobList.body.invoices.map((i: any) => i.number);
    expect(bobNumbers).toContain("ADM-S");
    expect(bobNumbers).not.toContain("ADM-A");

    // Bob cannot touch the Acme invoice
    expect((await h.api.get(`/api/invoices/${invAcme.body.invoice.id}`).set(...auth(h.tokens.bob))).status).toBe(404);
    expect((await h.api.delete(`/api/invoices/${invSmith.body.invoice.id}`).set(...auth(h.tokens.alice))).status).toBe(404);
  });

  it("RLS still scopes a tenant context after admin activity", async () => {
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.smith}/users`).set(...auth(h.tokens.admin)).send({ name: "Z", email: "z@smith.test" });
    await h.api.post("/api/admin/tenants").set(...auth(h.tokens.admin)).send({ name: "Third Co" });

    const ctx: RlsContext = { userId: h.ids.users.alice, tenantId: h.ids.tenants.acme, isAdmin: false };
    const rows = await h.db.withContext(ctx, (q) =>
      q.query<{ tenant_id: string }>("SELECT tenant_id FROM invoices"),
    );
    expect(rows.rows.every((r) => r.tenant_id === h.ids.tenants.acme)).toBe(true);
  });
});

describe("suspension / disable actually revoke access", () => {
  it("suspending a tenant blocks its users (403) but not the admin, and reactivation restores them", async () => {
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...auth(h.tokens.admin));

    const blocked = await h.api.get("/api/invoices").set(...auth(h.tokens.alice));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("tenant_suspended");

    const login = await h.api.post("/api/auth/login").send({ email: "alice@acme.test", password: "Password123!" });
    expect(login.status).toBe(403);

    // Smith unaffected
    expect((await h.api.get("/api/invoices").set(...auth(h.tokens.bob))).status).toBe(200);
    // admin still manages the suspended tenant
    expect((await h.api.get(`/api/admin/tenants/${h.ids.tenants.acme}`).set(...auth(h.tokens.admin))).status).toBe(200);

    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/reactivate`).set(...auth(h.tokens.admin));
    const restored = await h.api.get("/api/invoices").set(...auth(h.tokens.alice));
    expect(restored.status).toBe(200);
    expect(restored.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.acme)).toBe(true);
  });

  it("disabling a user revokes their existing token immediately", async () => {
    expect((await h.api.get("/api/invoices").set(...auth(h.tokens.bob))).status).toBe(200);

    await h.api.post(`/api/admin/users/${h.ids.users.bob}/disable`).set(...auth(h.tokens.admin));

    const after = await h.api.get("/api/invoices").set(...auth(h.tokens.bob));
    expect(after.status).toBe(403);
    expect(after.body.error.code).toBe("account_disabled");

    const login = await h.api.post("/api/auth/login").send({ email: "bob@smith.test", password: "Password123!" });
    expect(login.status).toBe(403);

    // other Smith activity is unaffected for other users (alice is Acme, still fine)
    expect((await h.api.get("/api/invoices").set(...auth(h.tokens.alice))).status).toBe(200);
  });
});
