import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";
import {
  algNoneToken,
  expiredToken,
  forgedClaimsToken,
  tamperPayload,
  UNKNOWN_UUID,
  wrongKeyToken,
} from "./helpers.ts";

/** Covers: 9 (JWT / privilege escalation), 10 (admin legit), 11 (admin-only), 12 (immutable role/tenant). */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

describe("9 — a tenant user cannot escalate via the JWT", () => {
  it("ignores attacker-injected role / tenant / admin claims", async () => {
    const token = forgedClaimsToken(h.ids.users.alice, {
      role: "admin",
      isAdmin: true,
      admin: true,
      tenantId: h.ids.tenants.smith,
      tid: h.ids.tenants.smith,
      scope: "admin",
      permissions: ["*"],
    });

    const me = await h.api.get("/api/auth/me").set(...auth(token));
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe("user");
    expect(me.body.user.tenantId).toBe(h.ids.tenants.acme);

    const invoices = await h.api.get("/api/invoices").set(...auth(token));
    expect(invoices.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.acme)).toBe(true);

    const admin = await h.api.get("/api/admin/users").set(...auth(token));
    expect(admin.status).toBe(403);
  });

  it("rejects an alg:none token", async () => {
    const token = algNoneToken({ sub: h.ids.users.admin, role: "admin" });
    const res = await h.api.get("/api/invoices").set(...auth(token));
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong key", async () => {
    const res = await h.api
      .get("/api/invoices")
      .set(...auth(wrongKeyToken(h.ids.users.admin, { role: "admin" })));
    expect(res.status).toBe(401);
  });

  it("rejects a token whose payload has been tampered with", async () => {
    const res = await h.api.get("/api/invoices").set(...auth(tamperPayload(h.tokens.alice)));
    expect(res.status).toBe(401);
  });

  it("rejects a token for a user that does not exist", async () => {
    const token = forgedClaimsToken(UNKNOWN_UUID, {});
    const res = await h.api.get("/api/invoices").set(...auth(token));
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const res = await h.api.get("/api/invoices").set(...auth(expiredToken(h.ids.users.alice)));
    expect(res.status).toBe(401);
  });

  it("rejects missing / malformed Authorization headers", async () => {
    for (const header of ["", "Bearer", "Bearer ", "Token abc", h.tokens.alice /* no scheme */]) {
      const res = await h.api.get("/api/invoices").set("Authorization", header);
      expect(res.status).toBe(401);
    }
  });
});

describe("11 — admin-only endpoints reject tenant users", () => {
  it("returns 403 for tenant users and 401 unauthenticated", async () => {
    const alice = await h.api.get("/api/admin/users").set(...auth(h.tokens.alice));
    expect(alice.status).toBe(403);
    const bob = await h.api.get("/api/admin/users").set(...auth(h.tokens.bob));
    expect(bob.status).toBe(403);
    const anon = await h.api.get("/api/admin/users");
    expect(anon.status).toBe(401);
  });
});

describe("12 — a user cannot change their own tenant_id or role via any API", () => {
  it("has no user-mutation endpoint", async () => {
    for (const path of ["/api/users/me", `/api/users/${h.ids.users.alice}`]) {
      const patch = await h.api.patch(path).set(...auth(h.tokens.alice)).send({ role: "admin" });
      const put = await h.api.put(path).set(...auth(h.tokens.alice)).send({ role: "admin" });
      expect(patch.status).toBe(404);
      expect(put.status).toBe(404);
    }
  });

  it("login rejects extra role/tenant fields in the request body", async () => {
    // Hardening pass: the login schema is now strict, so smuggled authorization
    // fields are a 400 rather than being silently dropped.
    const res = await h.api.post("/api/auth/login").send({
      email: "alice@acme.test",
      password: "Password123!",
      role: "admin",
      tenantId: h.ids.tenants.smith,
      isAdmin: true,
    });
    expect(res.status).toBe(400);

    // And a clean login still yields the real (unescalated) identity.
    const clean = await h.api
      .post("/api/auth/login")
      .send({ email: "alice@acme.test", password: "Password123!" });
    expect(clean.status).toBe(200);
    expect(clean.body.user.role).toBe("user");
    expect(clean.body.user.tenantId).toBe(h.ids.tenants.acme);
  });

  it("the invoice PATCH surface rejects role / tenantId keys", async () => {
    const own = h.ids.invoices.acme[0]!;
    for (const body of [{ role: "admin" }, { tenantId: h.ids.tenants.smith }, { tenant_id: h.ids.tenants.smith }]) {
      const res = await h.api.patch(`/api/invoices/${own}`).set(...auth(h.tokens.alice)).send(body);
      expect(res.status).toBe(400);
    }
  });

  it("RLS blocks self-promotion even if a write reached the users table", async () => {
    const ctx = { userId: h.ids.users.alice, tenantId: h.ids.tenants.acme, isAdmin: false };

    const promote = await h.db.withContext(ctx, (q) =>
      q.query("UPDATE users SET role = 'admin' WHERE id = $1", [h.ids.users.alice]),
    );
    expect(promote.rowCount).toBe(0);

    const move = await h.db.withContext(ctx, (q) =>
      q.query("UPDATE users SET tenant_id = $1 WHERE id = $2", [h.ids.tenants.smith, h.ids.users.alice]),
    );
    expect(move.rowCount).toBe(0);

    const check = await h.db.privileged((q) =>
      q.query<{ role: string; tenant_id: string }>(
        "SELECT role, tenant_id FROM users WHERE id = $1",
        [h.ids.users.alice],
      ),
    );
    expect(check.rows[0]!.role).toBe("user");
    expect(check.rows[0]!.tenant_id).toBe(h.ids.tenants.acme);
  });
});

describe("10 — an admin can legitimately view and manage both tenants", () => {
  it("sees invoices, users and tenants across both tenants", async () => {
    const invoices = await h.api.get("/api/invoices").set(...auth(h.tokens.admin));
    const seenTenants = new Set(invoices.body.invoices.map((i: any) => i.tenantId));
    expect(seenTenants.has(h.ids.tenants.acme)).toBe(true);
    expect(seenTenants.has(h.ids.tenants.smith)).toBe(true);

    const users = await h.api.get("/api/admin/users").set(...auth(h.tokens.admin));
    expect(users.status).toBe(200);
    expect(users.body.users.length).toBeGreaterThanOrEqual(3);

    const tenants = await h.api.get("/api/tenants").set(...auth(h.tokens.admin));
    expect(tenants.body.tenants.map((t: any) => t.slug).sort()).toEqual(["acme", "smith"]);
  });

  it("can filter invoices by tenant and fetch any invoice by id", async () => {
    const filtered = await h.api
      .get(`/api/invoices?tenantId=${h.ids.tenants.smith}`)
      .set(...auth(h.tokens.admin));
    expect(filtered.body.invoices.every((i: any) => i.tenantId === h.ids.tenants.smith)).toBe(true);

    for (const id of [h.ids.invoices.acme[0]!, h.ids.invoices.smith[0]!]) {
      const res = await h.api.get(`/api/invoices/${id}`).set(...auth(h.tokens.admin));
      expect(res.status).toBe(200);
    }
  });

  it("can create, modify and delete invoices in either tenant", async () => {
    for (const slug of ["acme", "smith"] as const) {
      const tenantId = h.ids.tenants[slug];
      const created = await h.api
        .post("/api/invoices")
        .set(...auth(h.tokens.admin))
        .send({ number: `ADM-${slug}`, clientName: "Admin Made", amountCents: 500, tenantId });
      expect(created.status).toBe(201);
      const id = created.body.invoice.id;

      const patched = await h.api
        .patch(`/api/invoices/${id}`)
        .set(...auth(h.tokens.admin))
        .send({ status: "sent" });
      expect(patched.status).toBe(200);
      expect(patched.body.invoice.status).toBe("sent");

      // the tenant's own user sees the admin's change
      const asTenant = slug === "acme" ? h.tokens.alice : h.tokens.bob;
      const visible = await h.api.get(`/api/invoices/${id}`).set(...auth(asTenant));
      expect(visible.status).toBe(200);

      const deleted = await h.api.delete(`/api/invoices/${id}`).set(...auth(h.tokens.admin));
      expect(deleted.status).toBe(204);
    }
  });
});
