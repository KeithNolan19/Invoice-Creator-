import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import supertest from "supertest";
import jwt from "jsonwebtoken";
import { config } from "../../src/config.ts";
import { createApp } from "../../src/http/app.ts";
import { LoginRateLimiter } from "../../src/http/rate-limit.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";
import { algNoneToken, expiredToken, tamperPayload, UNKNOWN_UUID, wrongKeyToken } from "./helpers.ts";

/** Requirement 1 — authentication hardening. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const PW = "Password123!";

describe("JWT expiry", () => {
  it("access tokens are short-lived (<= 30 minutes)", async () => {
    const res = await h.api.post("/api/auth/login").send({ email: "alice@acme.test", password: PW });
    const decoded = jwt.decode(res.body.token) as { iat: number; exp: number };
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(30 * 60);
    expect(decoded.exp - decoded.iat).toBeGreaterThan(0);
  });

  it("rejects expired / malformed / tampered / wrong-key / alg:none tokens", async () => {
    const bad = [
      expiredToken(h.ids.users.alice),
      wrongKeyToken(h.ids.users.admin, { role: "admin" }),
      tamperPayload(h.tokens.alice),
      algNoneToken({ sub: h.ids.users.admin, role: "admin" }),
      jwt.sign({}, config.jwt.secret, { subject: UNKNOWN_UUID, expiresIn: "1h" }),
      "not.a.jwt",
    ];
    for (const t of bad) {
      expect((await h.api.get("/api/invoices").set(...auth(t))).status).toBe(401);
    }
  });
});

describe("logout / token revocation", () => {
  it("logout kills the caller's existing tokens; a fresh login works again", async () => {
    const login = await h.api.post("/api/auth/login").send({ email: "alice@acme.test", password: PW });
    const token = login.body.token;
    expect((await h.api.get("/api/auth/me").set(...auth(token))).status).toBe(200);

    expect((await h.api.post("/api/auth/logout").set(...auth(token))).status).toBe(204);

    const afterLogout = await h.api.get("/api/auth/me").set(...auth(token));
    expect(afterLogout.status).toBe(401);
    expect(afterLogout.body.error.message).toMatch(/expired/i);

    const relogin = await h.api.post("/api/auth/login").send({ email: "alice@acme.test", password: PW });
    expect((await h.api.get("/api/auth/me").set(...auth(relogin.body.token))).status).toBe(200);
  });

  it("logout requires authentication", async () => {
    expect((await h.api.post("/api/auth/logout")).status).toBe(401);
  });

  it("disabling a user also revokes tokens issued before the disable", async () => {
    const login = await h.api.post("/api/auth/login").send({ email: "bob@smith.test", password: PW });
    await h.api.post(`/api/admin/users/${h.ids.users.bob}/disable`).set(...auth(h.tokens.admin));
    // even if the disabled_at gate were removed, the watermark alone kills it
    const row = await h.db.privileged((q) =>
      q.query<{ tokens_invalid_before: string | null }>(
        "SELECT tokens_invalid_before FROM users WHERE id = $1",
        [h.ids.users.bob],
      ),
    );
    expect(row.rows[0]!.tokens_invalid_before).not.toBeNull();
    expect((await h.api.get("/api/invoices").set(...auth(login.body.token))).status).toBe(403);
  });
});

describe("login brute-force protection", () => {
  const rlApi = () =>
    supertest(
      createApp(h.db, {
        loginRateLimiter: new LoginRateLimiter({
          maxAttemptsPerIdentity: 3,
          maxAttemptsPerIp: 6,
          windowMs: 60_000,
        }),
      }),
    );

  it("locks out after repeated failures and sets Retry-After", async () => {
    const api = rlApi();
    for (let i = 0; i < 3; i++) {
      const r = await api.post("/api/auth/login").send({ email: "alice@acme.test", password: "wrong" });
      expect(r.status).toBe(401);
    }
    const blocked = await api.post("/api/auth/login").send({ email: "alice@acme.test", password: "wrong" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    // even the correct password is refused while locked
    const stillBlocked = await api.post("/api/auth/login").send({ email: "alice@acme.test", password: PW });
    expect(stillBlocked.status).toBe(429);
  });

  it("a successful login clears the counter", async () => {
    const api = rlApi();
    await api.post("/api/auth/login").send({ email: "alice@acme.test", password: "wrong" });
    await api.post("/api/auth/login").send({ email: "alice@acme.test", password: "wrong" });
    expect((await api.post("/api/auth/login").send({ email: "alice@acme.test", password: PW })).status).toBe(200);
    // counter reset -> more attempts allowed
    for (let i = 0; i < 2; i++) {
      expect((await api.post("/api/auth/login").send({ email: "alice@acme.test", password: "wrong" })).status).toBe(401);
    }
  });

  it("the per-IP ceiling catches email rotation", async () => {
    const api = rlApi();
    for (let i = 0; i < 6; i++) {
      await api.post("/api/auth/login").send({ email: `probe${i}@nowhere.test`, password: "wrong" });
    }
    const blocked = await api.post("/api/auth/login").send({ email: "probe7@nowhere.test", password: "wrong" });
    expect(blocked.status).toBe(429);
  });
});

describe("no account enumeration", () => {
  it("unknown email and wrong password give an identical 401", async () => {
    const unknown = await h.api.post("/api/auth/login").send({ email: "ghost@nowhere.test", password: PW });
    const wrong = await h.api.post("/api/auth/login").send({ email: "alice@acme.test", password: "nope-wrong" });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it("the rate-limit response is identical for known and unknown emails", async () => {
    const api = supertest(
      createApp(h.db, {
        loginRateLimiter: new LoginRateLimiter({ maxAttemptsPerIdentity: 1, maxAttemptsPerIp: 99, windowMs: 60_000 }),
      }),
    );
    await api.post("/api/auth/login").send({ email: "alice@acme.test", password: "wrong" });
    const known = await api.post("/api/auth/login").send({ email: "alice@acme.test", password: "wrong" });
    await api.post("/api/auth/login").send({ email: "ghost@nowhere.test", password: "wrong" });
    const unknown = await api.post("/api/auth/login").send({ email: "ghost@nowhere.test", password: "wrong" });
    expect(known.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect(known.body).toEqual(unknown.body);
  });
});

describe("password policy (admin-set passwords)", () => {
  const createUser = (password?: string) =>
    h.api
      .post(`/api/admin/tenants/${h.ids.tenants.acme}/users`)
      .set(...auth(h.tokens.admin))
      .send({ name: "P", email: `p${Math.random().toString(36).slice(2)}@acme.test`, ...(password ? { password } : {}) });

  it("rejects short and common passwords, accepts strong ones", async () => {
    expect((await createUser("short")).status).toBe(400);
    expect((await createUser("passwordpassword")).status).toBe(400);
    const ok = await createUser("correct horse battery staple");
    expect(ok.status).toBe(201);
  });

  it("generated one-time passwords satisfy the policy", async () => {
    const res = await createUser();
    expect(res.status).toBe(201);
    expect(res.body.temporaryPassword.length).toBeGreaterThanOrEqual(12);
    const login = await h.api
      .post("/api/auth/login")
      .send({ email: res.body.user.email, password: res.body.temporaryPassword });
    expect(login.status).toBe(200);
  });
});
