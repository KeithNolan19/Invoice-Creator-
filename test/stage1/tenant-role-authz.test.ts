import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { config } from "../../src/config.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/**
 * Stage 1 — the tenant-admin / member authorization boundary.
 *
 * The only Stage-1 endpoints behind `requireTenantAdmin` are the team routes;
 * they stand in for every future tenant-admin action (settings, integration,
 * void). Authorization is resolved from the authenticated user's DB row, never
 * from the token or the request body.
 */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const adminEndpoints = () => [
  { method: "get" as const, path: "/api/team/members", body: undefined as unknown },
  {
    method: "patch" as const,
    path: () => `/api/team/members/${h.ids.users.bob}`,
    body: { tenantRole: "member" },
  },
];

describe("tenant-admin functionality", () => {
  it("a tenant admin can reach it", async () => {
    const list = await h.api.get("/api/team/members").set(...auth(h.tokens.alice));
    expect(list.status).toBe(200);
    expect(list.body.members.map((m: any) => m.email)).toEqual(["alice@acme.test"]);
    expect(list.body.members[0].tenantRole).toBe("admin");
  });

  it("a tenant member gets 403 on every tenant-admin endpoint", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    for (const ep of adminEndpoints()) {
      const path = typeof ep.path === "function" ? ep.path() : ep.path;
      let req = h.api[ep.method](path).set(...auth(carol.token));
      if (ep.body) req = req.send(ep.body as object);
      const res = await req;
      expect(res.status, path).toBe(403);
    }
  });

  it("an unauthenticated request gets 401", async () => {
    expect((await h.api.get("/api/team/members")).status).toBe(401);
    expect((await h.api.patch(`/api/team/members/${h.ids.users.bob}`).send({ tenantRole: "member" })).status).toBe(401);
  });

  it("a platform admin does not pass the tenant-admin gate (they use the Admin Control Centre)", async () => {
    expect((await h.api.get("/api/team/members").set(...auth(h.tokens.admin))).status).toBe(403);
  });
});

describe("browser / JWT cannot escalate the tenant role", () => {
  it("a member sending X-Tenant-Role / body tenantRole is still 403", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    const spoofHeader = await h.api
      .get("/api/team/members")
      .set(...auth(carol.token))
      .set("X-Tenant-Role", "admin");
    expect(spoofHeader.status).toBe(403);

    const spoofBody = await h.api
      .patch(`/api/team/members/${h.ids.users.alice}`)
      .set(...auth(carol.token))
      .send({ tenantRole: "member", role: "admin", isAdmin: true });
    expect(spoofBody.status).toBe(403);
  });

  it("a forged JWT with tenant_role / role / admin claims does not help", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    const forged = jwt.sign(
      { tenant_role: "admin", tenantRole: "admin", role: "admin", isAdmin: true },
      config.jwt.secret,
      { subject: carol.id, expiresIn: "1h" },
    );
    expect((await h.api.get("/api/team/members").set(...auth(forged))).status).toBe(403);

    // and it is still just a member on the normal surface
    const me = await h.api.get("/api/auth/me").set(...auth(forged));
    expect(me.body.user.tenantRole).toBe("member");
    expect(me.body.user.role).toBe("user");
  });

  it("authorization tracks the database row, not the token", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    expect((await h.api.get("/api/team/members").set(...auth(carol.token))).status).toBe(403);

    // alice (tenant admin) promotes carol
    const promote = await h.api
      .patch(`/api/team/members/${carol.id}`)
      .set(...auth(h.tokens.alice))
      .send({ tenantRole: "admin" });
    expect(promote.status).toBe(200);
    expect(promote.body.member.tenantRole).toBe("admin");

    // carol's SAME token now passes — the middleware re-reads her row
    expect((await h.api.get("/api/team/members").set(...auth(carol.token))).status).toBe(200);

    // demote again -> locked out again
    await h.api
      .patch(`/api/team/members/${carol.id}`)
      .set(...auth(h.tokens.alice))
      .send({ tenantRole: "member" });
    expect((await h.api.get("/api/team/members").set(...auth(carol.token))).status).toBe(403);
  });
});

describe("PATCH /api/team/members/:id negative cases", () => {
  it("rejects an unknown key or an invalid role (strict, 400)", async () => {
    for (const body of [{ tenantRole: "owner" }, { tenantRole: "admin", note: "x" }, {}]) {
      const res = await h.api
        .patch(`/api/team/members/${h.ids.users.bob}`)
        .set(...auth(h.tokens.alice))
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it("a tenant admin cannot change their own role (self-lockout guard)", async () => {
    const res = await h.api
      .patch(`/api/team/members/${h.ids.users.alice}`)
      .set(...auth(h.tokens.alice))
      .send({ tenantRole: "member" });
    expect(res.status).toBe(409);
  });

  it("cannot target a user in another tenant (404)", async () => {
    const res = await h.api
      .patch(`/api/team/members/${h.ids.users.bob}`)
      .set(...auth(h.tokens.alice))
      .send({ tenantRole: "member" });
    expect(res.status).toBe(404);

    // bob is untouched
    const bobRole = await h.db.privileged((q) =>
      q.query<{ tenant_role: string }>("SELECT tenant_role FROM users WHERE id = $1", [h.ids.users.bob]),
    );
    expect(bobRole.rows[0]!.tenant_role).toBe("admin");
  });

  it("cannot target a platform admin (404)", async () => {
    const res = await h.api
      .patch(`/api/team/members/${h.ids.users.admin}`)
      .set(...auth(h.tokens.alice))
      .send({ tenantRole: "member" });
    expect(res.status).toBe(404);
  });

  it("a malformed id is 404", async () => {
    expect(
      (await h.api.patch("/api/team/members/not-a-uuid").set(...auth(h.tokens.alice)).send({ tenantRole: "member" }))
        .status,
    ).toBe(404);
  });
});

describe("the role-change function is guarded at the database layer too", () => {
  it("a member's context cannot call set_tenant_member_role", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    await expect(
      h.db.withContext(
        { userId: carol.id, tenantId: h.ids.tenants.acme, isAdmin: false, tenantRole: "member" },
        (q) => q.query("SELECT set_tenant_member_role($1, 'admin')", [carol.id]),
      ),
    ).rejects.toThrow(/not a tenant admin|insufficient/i);

    // carol is still a member
    const row = await h.db.privileged((q) =>
      q.query<{ tenant_role: string }>("SELECT tenant_role FROM users WHERE id = $1", [carol.id]),
    );
    expect(row.rows[0]!.tenant_role).toBe("member");
  });

  it("a tenant admin's context cannot use it to reach into another tenant", async () => {
    const daveSmith = await h.createUser({ tenant: "smith", tenantRole: "member" });
    const changed = await h.db.withContext(
      { userId: h.ids.users.alice, tenantId: h.ids.tenants.acme, isAdmin: false, tenantRole: "admin" },
      (q) => q.query<{ tenant_id: string | null }>("SELECT set_tenant_member_role($1, 'admin') AS tenant_id", [daveSmith.id]),
    );
    expect(changed.rows[0]!.tenant_id).toBeNull(); // nothing matched
    const row = await h.db.privileged((q) =>
      q.query<{ tenant_role: string }>("SELECT tenant_role FROM users WHERE id = $1", [daveSmith.id]),
    );
    expect(row.rows[0]!.tenant_role).toBe("member");
  });
});

describe("identity responses carry the tenant role", () => {
  it("login and /me return tenantRole from the database", async () => {
    const login = await h.api
      .post("/api/auth/login")
      .send({ email: "alice@acme.test", password: "Password123!" });
    expect(login.body.user.tenantRole).toBe("admin");

    const carol = await h.createUser({ tenant: "smith", tenantRole: "member" });
    const me = await h.api.get("/api/auth/me").set(...auth(carol.token));
    expect(me.body.user).toMatchObject({ tenantRole: "member", role: "user", tenantId: h.ids.tenants.smith });

    const platform = await h.api.get("/api/auth/me").set(...auth(h.tokens.admin));
    expect(platform.body.user.tenantRole).toBeNull();
  });
});
