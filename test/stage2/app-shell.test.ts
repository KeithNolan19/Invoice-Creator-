import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Stage 2 — the customer application shell + the authorization matrix for its API. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("the customer SPA is served statically", () => {
  it("serves the shell and assets, and the bundle carries no secrets", async () => {
    const page = await h.api.get("/app/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<title>Invoice Creator</title>");
    expect(page.text).toContain('data-nav="dashboard"');

    const js = await h.api.get("/app/app.js");
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);

    const css = await h.api.get("/app/styles.css");
    expect(css.status).toBe(200);

    const login = await h.api.get("/app/login");
    expect(login.status).toBe(200);
    expect(login.text).toContain('id="login-form"');

    for (const f of ["web/app/index.html", "web/app/app.js", "web/app/styles.css", "web/app/login.html", "web/app/login.js"]) {
      const text = readFileSync(repoRoot + f, "utf8");
      expect(text).not.toMatch(/postgres(?:ql)?:\/\/|DATABASE_URL|JWT_SECRET|password_hash|_ciphertext|BYPASSRLS/i);
    }
  });

  it("deep links under /app serve the SPA shell; missing assets 404", async () => {
    for (const p of ["/app", "/app/", "/app/dashboard", "/app/customers", `/app/invoices/${crypto.randomUUID()}`]) {
      const res = await h.api.get(p);
      expect(res.status, p).toBe(200);
      expect(res.text, p).toContain('data-nav="dashboard"');
    }
    // login is its own page, not the shell
    expect((await h.api.get("/app/login")).text).not.toContain('data-nav="dashboard"');
    // a missing asset is a 404, not the shell
    expect((await h.api.get("/app/nope.js")).status).toBe(404);
  });

  it("the customer app is separate from the existing sign-in mockup", () => {
    // The standalone sign-in mockup keeps its restrained design and its own file.
    const mockup = readFileSync(repoRoot + "test-version-1.html", "utf8");
    expect(mockup).toContain("<h1>Sign in</h1>");
    expect(mockup).toMatch(/Newsreader/);
    expect(mockup).not.toContain('id="login-form"'); // the mockup does not post anywhere

    // The working sign-in form lives on its own page; the shell has no gate.
    expect(readFileSync(repoRoot + "web/app/login.html", "utf8")).toContain('id="login-form"');
    expect(readFileSync(repoRoot + "web/app/index.html", "utf8")).not.toContain('id="login-form"');
  });
});

interface Ep {
  method: "get" | "post" | "put" | "patch";
  path: () => string;
  body?: object;
  adminOnly?: boolean;
}
const endpoints = (): Ep[] => [
  { method: "get", path: () => "/api/dashboard" },
  { method: "get", path: () => "/api/customers" },
  { method: "post", path: () => "/api/customers", body: { name: "X" } },
  { method: "get", path: () => `/api/customers/${crypto.randomUUID()}` },
  { method: "get", path: () => "/api/settings/business" },
  { method: "put", path: () => "/api/settings/business", body: { businessName: "X" }, adminOnly: true },
  { method: "get", path: () => "/api/settings/payment-integration", adminOnly: true },
  { method: "get", path: () => "/api/team/members", adminOnly: true },
  { method: "patch", path: () => `/api/team/members/${h.ids.users.alice}`, body: { tenantRole: "member" }, adminOnly: true },
];

function send(ep: Ep, token?: string) {
  let r = h.api[ep.method](ep.path());
  if (token) r = r.set(...auth(token));
  if (ep.body) r = r.send(ep.body);
  return r;
}

describe("authorization matrix for the customer API", () => {
  it("unauthenticated -> 401 everywhere", async () => {
    for (const ep of endpoints()) {
      expect((await send(ep)).status, ep.path()).toBe(401);
    }
  });

  it("platform admin -> 403 everywhere (wrong application)", async () => {
    for (const ep of endpoints()) {
      expect((await send(ep, h.tokens.admin)).status, ep.path()).toBe(403);
    }
  });

  it("tenant member: reaches shared areas, refused from admin-only areas", async () => {
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    for (const ep of endpoints()) {
      const status = (await send(ep, carol.token)).status;
      if (ep.adminOnly) {
        expect(status, ep.path()).toBe(403);
      } else {
        expect([200, 201, 400, 404], `${ep.path()} -> ${status}`).toContain(status);
      }
    }
  });

  it("tenant admin: passes the gate on every endpoint (never 401/403)", async () => {
    for (const ep of endpoints()) {
      const status = (await send(ep, h.tokens.alice)).status;
      expect([401, 403], `${ep.path()} -> ${status}`).not.toContain(status);
    }
  });

  it("a forged tenant_role claim does not unlock admin-only areas", async () => {
    const jwt = (await import("jsonwebtoken")).default;
    const { config } = await import("../../src/config.ts");
    const carol = await h.createUser({ tenant: "acme", tenantRole: "member" });
    const forged = jwt.sign({ tenantRole: "admin", role: "admin" }, config.jwt.secret, {
      subject: carol.id,
      expiresIn: "1h",
    });
    for (const ep of endpoints().filter((e) => e.adminOnly)) {
      expect((await send(ep, forged)).status, ep.path()).toBe(403);
    }
  });

  it("a suspended tenant blocks its users across the customer API", async () => {
    await h.api.post(`/api/admin/tenants/${h.ids.tenants.acme}/suspend`).set(...auth(h.tokens.admin));
    for (const ep of endpoints()) {
      expect((await send(ep, h.tokens.alice)).status, ep.path()).toBe(403);
    }
    // Smith is unaffected
    expect((await h.api.get("/api/dashboard").set(...auth(h.tokens.bob))).status).toBe(200);
  });
});
