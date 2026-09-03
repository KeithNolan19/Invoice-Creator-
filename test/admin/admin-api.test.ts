import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Functional coverage for the Admin Control Centre API (all as the platform admin). */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const admin = () => auth(h.tokens.admin);

describe("dashboard", () => {
  it("reports platform-wide counts", async () => {
    const res = await h.api.get("/api/admin/dashboard").set(...admin());
    expect(res.status).toBe(200);
    expect(res.body.stats.tenants).toEqual({ total: 2, active: 2, suspended: 0 });
    expect(res.body.stats.users.total).toBe(3);
    expect(res.body.stats.users.active).toBe(3);
    expect(res.body.stats.activity.totalInvoices).toBe(
      h.ids.invoices.acme.length + h.ids.invoices.smith.length,
    );
    expect(res.body.stats.activity.adminActions).toBe(0);
  });

  it("moves counts as tenants/users change state", async () => {
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.smith}/suspend`).set(...admin());
    await h.api.post(`/api/admin/users/${h.ids.users.bob}/disable`).set(...admin());

    const res = await h.api.get("/api/admin/dashboard").set(...admin());
    expect(res.body.stats.tenants).toEqual({ total: 2, active: 1, suspended: 1 });
    expect(res.body.stats.users.disabled).toBe(1);
    expect(res.body.stats.activity.adminActions).toBe(2);
  });
});

describe("tenant list", () => {
  it("lists all tenants", async () => {
    const res = await h.api.get("/api/admin/tenants").set(...admin());
    expect(res.status).toBe(200);
    expect(res.body.tenants.map((t: any) => t.slug).sort()).toEqual(["acme", "smith"]);
    expect(res.body.tenants[0]).toHaveProperty("status", "active");
  });

  it("searches by name and slug (case-insensitive)", async () => {
    const byName = await h.api.get("/api/admin/tenants?search=acme").set(...admin());
    expect(byName.body.tenants.map((t: any) => t.slug)).toEqual(["acme"]);
    const byPartial = await h.api.get("/api/admin/tenants?search=SMI").set(...admin());
    expect(byPartial.body.tenants.map((t: any) => t.slug)).toEqual(["smith"]);
    const none = await h.api.get("/api/admin/tenants?search=zzz").set(...admin());
    expect(none.body.tenants).toEqual([]);
  });

  it("filters by status", async () => {
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...admin());
    const active = await h.api.get("/api/admin/tenants?status=active").set(...admin());
    expect(active.body.tenants.map((t: any) => t.slug)).toEqual(["smith"]);
    const suspended = await h.api.get("/api/admin/tenants?status=suspended").set(...admin());
    expect(suspended.body.tenants.map((t: any) => t.slug)).toEqual(["acme"]);
  });
});

describe("tenant detail", () => {
  it("returns company info, usage and users", async () => {
    const res = await h.api.get(`/api/admin/tenants/${h.ids.tenants.acme}`).set(...admin());
    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({ id: h.ids.tenants.acme, name: "Acme Ltd", status: "active" });
    expect(res.body.tenant).toHaveProperty("createdAt");
    expect(res.body.usage.invoiceCount).toBe(h.ids.invoices.acme.length);
    expect(res.body.usage.userCount).toBe(1);
    expect(res.body.users.map((u: any) => u.email)).toEqual(["alice@acme.test"]);
    expect(res.body.users[0]).not.toHaveProperty("passwordHash");
  });

  it("404s for an unknown or malformed id", async () => {
    expect((await h.api.get("/api/admin/tenants/99999999-9999-4999-8999-999999999999").set(...admin())).status).toBe(404);
    expect((await h.api.get("/api/admin/tenants/not-a-uuid").set(...admin())).status).toBe(404);
  });
});

describe("tenant management", () => {
  it("creates a tenant (slug auto-derived) and writes an audit row", async () => {
    const res = await h.api.post("/api/admin/tenants").set(...admin()).send({ name: "Wayne Enterprises" });
    expect(res.status).toBe(201);
    expect(res.body.tenant).toMatchObject({ name: "Wayne Enterprises", slug: "wayne-enterprises", status: "active" });

    const audit = await h.api.get("/api/admin/audit-logs").set(...admin());
    expect(audit.body.auditLogs[0]).toMatchObject({
      action: "tenant.created",
      tenant: { id: res.body.tenant.id, name: "Wayne Enterprises" },
    });
    expect(audit.body.auditLogs[0].actor.email).toBe("admin@invoicecreator.test");
  });

  it("rejects a duplicate slug with 409", async () => {
    const res = await h.api.post("/api/admin/tenants").set(...admin()).send({ name: "Acme Again", slug: "acme" });
    expect(res.status).toBe(409);
  });

  it("rejects unknown body keys (no role / status injection)", async () => {
    const res = await h.api
      .post("/api/admin/tenants")
      .set(...admin())
      .send({ name: "Sneaky", status: "suspended", id: "x" });
    expect(res.status).toBe(400);
  });

  it("suspends and reactivates, auditing each transition", async () => {
    const suspend = await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...admin());
    expect(suspend.status).toBe(200);
    expect(suspend.body.tenant.status).toBe("suspended");

    const doubleSuspend = await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...admin());
    expect(doubleSuspend.status).toBe(409);

    const reactivate = await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/reactivate`).set(...admin());
    expect(reactivate.status).toBe(200);
    expect(reactivate.body.tenant.status).toBe("active");

    const audit = await h.api.get("/api/admin/audit-logs").set(...admin());
    expect(audit.body.auditLogs.map((e: any) => e.action)).toEqual(["tenant.reactivated", "tenant.suspended"]);
  });

  it("does not offer tenant deletion", async () => {
    const res = await h.api.delete(`/api/admin/tenants/${h.ids.tenants.acme}`).set(...admin());
    expect(res.status).toBe(404);
  });
});

describe("user management", () => {
  it("lists users for a tenant", async () => {
    const res = await h.api.get(`/api/admin/tenants/${h.ids.tenants.smith}/users`).set(...admin());
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: any) => u.email)).toEqual(["bob@smith.test"]);
  });

  it("creates a tenant user with a generated one-time password and audits it", async () => {
    const res = await h.api
      .post(`/api/admin/tenants/${h.ids.tenants.acme}/users`)
      .set(...admin())
      .send({ name: "Carol", email: "carol@acme.test" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: "carol@acme.test", role: "user", tenantId: h.ids.tenants.acme });
    expect(typeof res.body.temporaryPassword).toBe("string");

    // the new user can authenticate with that password
    const login = await h.api
      .post("/api/auth/login")
      .send({ email: "carol@acme.test", password: res.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.tenantId).toBe(h.ids.tenants.acme);

    const audit = await h.api.get("/api/admin/audit-logs").set(...admin());
    expect(audit.body.auditLogs[0]).toMatchObject({ action: "user.created", tenant: { id: h.ids.tenants.acme } });
  });

  it("accepts an explicit password when provided", async () => {
    const res = await h.api
      .post(`/api/admin/tenants/${h.ids.tenants.acme}/users`)
      .set(...admin())
      .send({ name: "Dave", email: "dave@acme.test", password: "s3cret-pass-123" });
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword).toBeUndefined();
    const login = await h.api.post("/api/auth/login").send({ email: "dave@acme.test", password: "s3cret-pass-123" });
    expect(login.status).toBe(200);
  });

  it("ignores a body-supplied tenantId / role — the URL tenant wins", async () => {
    const res = await h.api
      .post(`/api/admin/tenants/${h.ids.tenants.acme}/users`)
      .set(...admin())
      .send({ name: "Eve", email: "eve@acme.test", tenantId: h.ids.tenants.smith, role: "admin" });
    expect(res.status).toBe(400); // strict schema rejects unknown keys
  });

  it("rejects a duplicate email with 409", async () => {
    const res = await h.api
      .post(`/api/admin/tenants/${h.ids.tenants.acme}/users`)
      .set(...admin())
      .send({ name: "Alice II", email: "alice@acme.test" });
    expect(res.status).toBe(409);
  });

  it("disables a user without touching their tenant or role", async () => {
    const before = await h.api.get(`/api/admin/tenants/${h.ids.tenants.smith}/users`).set(...admin());
    const bob = before.body.users.find((u: any) => u.email === "bob@smith.test");

    const res = await h.api.post(`/api/admin/users/${h.ids.users.bob}/disable`).set(...admin());
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ disabled: true, tenantId: bob.tenantId, role: "user" });

    const again = await h.api.post(`/api/admin/users/${h.ids.users.bob}/disable`).set(...admin());
    expect(again.status).toBe(409);

    const audit = await h.api.get("/api/admin/audit-logs").set(...admin());
    expect(audit.body.auditLogs[0]).toMatchObject({
      action: "user.disabled",
      tenant: { id: h.ids.tenants.smith },
      targetUser: { id: h.ids.users.bob },
    });
  });

  it("refuses to disable a platform admin", async () => {
    const res = await h.api.post(`/api/admin/users/${h.ids.users.admin}/disable`).set(...admin());
    expect(res.status).toBe(400);
  });

  it("re-enables a disabled user without changing their tenant or role", async () => {
    await h.api.post(`/api/admin/users/${h.ids.users.bob}/disable`).set(...admin());

    const res = await h.api.post(`/api/admin/users/${h.ids.users.bob}/enable`).set(...admin());
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      id: h.ids.users.bob,
      disabled: false,
      tenantId: h.ids.tenants.smith,
      role: "user",
    });

    // enabling again is a no-op conflict
    const again = await h.api.post(`/api/admin/users/${h.ids.users.bob}/enable`).set(...admin());
    expect(again.status).toBe(409);

    // access is restored, still scoped to Smith
    const login = await h.api.post("/api/auth/login").send({ email: "bob@smith.test", password: "Password123!" });
    expect(login.status).toBe(200);
    const invoices = await h.api.get("/api/invoices").set(...auth(login.body.token));
    expect(invoices.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.smith)).toBe(true);

    const audit = await h.api.get("/api/admin/audit-logs").set(...admin());
    expect(audit.body.auditLogs[0]).toMatchObject({
      action: "user.enabled",
      tenant: { id: h.ids.tenants.smith },
      targetUser: { id: h.ids.users.bob },
    });
  });

  it("enabling a user who is not disabled is a 409", async () => {
    const res = await h.api.post(`/api/admin/users/${h.ids.users.bob}/enable`).set(...admin());
    expect(res.status).toBe(409);
  });
});

describe("strict input validation & error hygiene", () => {
  it("action endpoints reject any request body", async () => {
    for (const path of [
      `/api/admin/tenants/${h.ids.tenants.acme}/suspend`,
      `/api/admin/tenants/${h.ids.tenants.acme}/reactivate`,
      `/api/admin/users/${h.ids.users.bob}/disable`,
      `/api/admin/users/${h.ids.users.bob}/enable`,
    ]) {
      const res = await h.api.post(path).set(...admin()).send({ role: "admin", disabled_at: null });
      expect([400], `${path} -> ${res.status}`).toContain(res.status);
    }
  });

  it("malformed ids are 404, not 400/500, and never echo SQL", async () => {
    for (const bad of ["not-a-uuid", "1 OR 1=1", "'; DROP TABLE tenants;--"]) {
      const res = await h.api.get(`/api/admin/tenants/${encodeURIComponent(bad)}`).set(...admin());
      expect(res.status).toBe(404);
    }
  });

  it("error responses never leak DB internals, stack traces or SQL", async () => {
    const responses = await Promise.all([
      h.api.post("/api/admin/tenants").set(...admin()).send({ name: "Dup", slug: "acme" }), // 409
      h.api.post("/api/admin/tenants").set(...admin()).send({}), // 400
      h.api.get("/api/admin/tenants/00000000-0000-0000-0000-000000000000").set(...admin()), // 404
      h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/users`).set(...admin()).send({ name: "x", email: "not-email" }), // 400
    ]);
    for (const r of responses) {
      const body = JSON.stringify(r.body).toLowerCase();
      expect(body).not.toMatch(/postgres|pg_|syntax error|relation ".*" does not|at \/|\.ts:\d+|node_modules|econnrefused/);
      expect(r.body.error).toBeDefined();
      expect(typeof r.body.error.message).toBe("string");
    }
  });
});

describe("admin UI is served statically", () => {
  it("serves the SPA shell and its assets without auth, but no secrets", async () => {
    const page = await h.api.get("/admin/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("Admin Control Centre");
    expect(page.text).not.toContain('id="login-form"'); // the shell has no gate

    const js = await h.api.get("/admin/app.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    for (const f of ["/admin/app.js", "/admin/login.js", "/admin/styles.css"]) {
      const r = await h.api.get(f);
      expect(r.status, f).toBe(200);
      expect(r.text).not.toMatch(/postgres:\/\/|DATABASE_URL|JWT_SECRET|password_hash|_ciphertext/i);
    }
  });

  it("has a dedicated sign-in page and serves the shell for deep links", async () => {
    expect((await h.api.get("/admin")).status).toBe(301); // bare -> /admin/

    const login = await h.api.get("/admin/login");
    expect(login.status).toBe(200);
    expect(login.text).toContain('id="login-form"');

    for (const p of ["/admin/", "/admin/dashboard", `/admin/tenants/${crypto.randomUUID()}`, "/admin/support"]) {
      const res = await h.api.get(p);
      expect(res.status, p).toBe(200);
      expect(res.text, p).toContain('data-nav="dashboard"');
    }
    expect((await h.api.get("/admin/missing.js")).status).toBe(404);
  });
});

describe("audit log", () => {
  it("records who / what / which tenant / when, newest first", async () => {
    await h.api.post("/api/admin/tenants").set(...admin()).send({ name: "First Co" });
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...admin());

    const res = await h.api.get("/api/admin/audit-logs").set(...admin());
    expect(res.status).toBe(200);
    expect(res.body.auditLogs).toHaveLength(2);
    const [latest, first] = res.body.auditLogs;
    expect(latest.action).toBe("tenant.suspended");
    expect(first.action).toBe("tenant.created");
    expect(latest.actor.email).toBe("admin@invoicecreator.test");
    expect(new Date(latest.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(first.createdAt).getTime());
  });

  it("can be filtered by tenant", async () => {
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...admin());
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.smith}/suspend`).set(...admin());
    const res = await h.api.get(`/api/admin/audit-logs?tenantId=${h.ids.tenants.acme}`).set(...admin());
    expect(res.body.auditLogs).toHaveLength(1);
    expect(res.body.auditLogs[0].tenant.id).toBe(h.ids.tenants.acme);
  });
});
