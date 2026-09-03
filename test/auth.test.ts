import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { config } from "../src/config.ts";
import { SEED_PASSWORD } from "../src/db/seed.ts";
import { auth, createHarness, type Harness } from "./support/harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe("authentication", () => {
  it("issues a token for valid credentials", async () => {
    const res = await h.api
      .post("/api/auth/login")
      .send({ email: "alice@acme.test", password: SEED_PASSWORD });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe("string");
    expect(res.body.user).toMatchObject({ email: "alice@acme.test", role: "user" });
    expect(res.body.user.tenantId).toBe(h.ids.tenants.acme);
    expect(res.body.user).not.toHaveProperty("password_hash");
  });

  it("rejects a wrong password", async () => {
    const res = await h.api
      .post("/api/auth/login")
      .send({ email: "alice@acme.test", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
  });

  it("rejects an unknown email with the same 401 (no user enumeration)", async () => {
    const res = await h.api
      .post("/api/auth/login")
      .send({ email: "nobody@nowhere.test", password: SEED_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe("Invalid email or password");
  });

  it("validates the login body", async () => {
    const res = await h.api.post("/api/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("returns the current user from /me", async () => {
    const res = await h.api.get("/api/auth/me").set(...auth(h.tokens.admin));
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: "admin@invoicecreator.test", role: "admin" });
    expect(res.body.user.tenantId).toBeNull();
  });

  it("rejects protected routes with no token", async () => {
    const res = await h.api.get("/api/invoices");
    expect(res.status).toBe(401);
  });

  it("rejects a malformed token", async () => {
    const res = await h.api.get("/api/invoices").set("Authorization", "Bearer not.a.jwt");
    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({}, config.jwt.secret, {
      subject: "00000000-0000-0000-0000-000000000000",
      expiresIn: -10,
    });
    const res = await h.api.get("/api/invoices").set(...auth(expired));
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign({}, "some-other-secret", {
      subject: "00000000-0000-0000-0000-000000000000",
      expiresIn: "1h",
    });
    const res = await h.api.get("/api/invoices").set(...auth(forged));
    expect(res.status).toBe(401);
  });
});
