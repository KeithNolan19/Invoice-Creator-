import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RlsContext } from "../../src/db/types.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Covers: 8 (no context => no rows), 13 (context cleanup / no leakage), 14 (INSERT/UPDATE/DELETE under RLS). */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const userCtx = (slug: "acme" | "smith"): RlsContext => ({
  userId: h.ids.users[slug === "acme" ? "alice" : "bob"],
  tenantId: h.ids.tenants[slug],
  isAdmin: false,
});
const adminCtx = (): RlsContext => ({ userId: h.ids.users.admin, tenantId: null, isAdmin: true });
const noCtx = (): RlsContext => ({ userId: h.ids.users.alice, tenantId: null, isAdmin: false });

describe("8 — no tenant context yields zero tenant-owned rows", () => {
  it("withContext without a tenant sees nothing in any tenant-owned table", async () => {
    const rows = await h.db.withContext(noCtx(), async (q) => ({
      invoices: (await q.query("SELECT * FROM invoices")).rows.length,
      users: (await q.query("SELECT * FROM users")).rows.length,
      tenants: (await q.query("SELECT * FROM tenants")).rows.length,
    }));
    expect(rows).toEqual({ invoices: 0, users: 0, tenants: 0 });
  });

  it("an unknown tenant id also sees nothing", async () => {
    const bogus: RlsContext = { userId: h.ids.users.alice, tenantId: "99999999-9999-4999-8999-999999999999", isAdmin: false };
    const n = await h.db.withContext(bogus, (q) => q.query("SELECT * FROM invoices"));
    expect(n.rows.length).toBe(0);
  });

  it("the app DB role with no GUCs set sees nothing (fails closed)", async () => {
    const count = await h.db.privileged(async (q) => {
      await q.exec("BEGIN");
      await q.exec("SET LOCAL ROLE invoice_app");
      const r = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM invoices");
      await q.exec("ROLLBACK");
      return r.rows[0]!.n;
    });
    expect(count).toBe(0);
  });

  it("unauthenticated HTTP requests are 401, never an empty 200", async () => {
    for (const path of ["/api/invoices", "/api/users", "/api/tenants"]) {
      const res = await h.api.get(path);
      expect(res.status).toBe(401);
    }
  });
});

describe("13 — one request's context cannot leak into the next", () => {
  it("a later context is not widened by an earlier one", async () => {
    const acme = await h.db.withContext(userCtx("acme"), (q) =>
      q.query<{ tenant_id: string }>("SELECT tenant_id FROM invoices"),
    );
    expect(acme.rows.every((r) => r.tenant_id === h.ids.tenants.acme)).toBe(true);

    const smith = await h.db.withContext(userCtx("smith"), (q) =>
      q.query<{ tenant_id: string }>("SELECT tenant_id FROM invoices"),
    );
    expect(smith.rows.every((r) => r.tenant_id === h.ids.tenants.smith)).toBe(true);
  });

  it("the role/GUCs are reset so a following privileged call sees everything", async () => {
    await h.db.withContext(userCtx("acme"), (q) => q.query("SELECT 1"));
    const all = await h.db.privileged((q) =>
      q.query<{ n: number }>("SELECT count(*)::int AS n FROM invoices"),
    );
    expect(all.rows[0]!.n).toBe(h.ids.invoices.acme.length + h.ids.invoices.smith.length);
  });

  it("a throwing context is rolled back cleanly and does not poison the next one", async () => {
    await expect(
      h.db.withContext(userCtx("acme"), async (q) => {
        await q.query("SELECT 1");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const smith = await h.db.withContext(userCtx("smith"), (q) =>
      q.query<{ tenant_id: string }>("SELECT tenant_id FROM invoices"),
    );
    expect(smith.rows.length).toBeGreaterThan(0);
    expect(smith.rows.every((r) => r.tenant_id === h.ids.tenants.smith)).toBe(true);
  });

  it("interleaved contexts stay isolated under concurrency", async () => {
    const jobs = Array.from({ length: 24 }, (_, i) => {
      const slug = i % 2 === 0 ? "acme" : "smith";
      return h.db
        .withContext(userCtx(slug), (q) => q.query<{ tenant_id: string }>("SELECT tenant_id FROM invoices"))
        .then((r) => ({ slug, ok: r.rows.every((row) => row.tenant_id === h.ids.tenants[slug]) }));
    });
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("concurrent HTTP requests with different tokens each stay scoped", async () => {
    const jobs = Array.from({ length: 20 }, (_, i) => {
      const [tok, tenantId] =
        i % 2 === 0 ? [h.tokens.alice, h.ids.tenants.acme] : [h.tokens.bob, h.ids.tenants.smith];
      return h.api
        .get("/api/invoices")
        .set(...auth(tok))
        .then((res) => res.body.invoices.every((inv: any) => inv.tenantId === tenantId));
    });
    expect((await Promise.all(jobs)).every(Boolean)).toBe(true);
  });
});

describe("14 — INSERT / UPDATE / DELETE are enforced by RLS, not just SELECT", () => {
  it("cross-tenant INSERT is blocked by WITH CHECK", async () => {
    await expect(
      h.db.withContext(userCtx("acme"), (q) =>
        q.query(
          `INSERT INTO invoices (tenant_id, number, client_name, amount_cents)
             VALUES ($1, 'X-1', 'x', 1)`,
          [h.ids.tenants.smith],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("moving your own row into another tenant is blocked by WITH CHECK", async () => {
    await expect(
      h.db.withContext(userCtx("acme"), (q) =>
        q.query("UPDATE invoices SET tenant_id = $1 WHERE id = $2", [
          h.ids.tenants.smith,
          h.ids.invoices.acme[0],
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cross-tenant UPDATE / DELETE affect zero rows and change nothing", async () => {
    const victim = h.ids.invoices.smith[0]!;

    const upd = await h.db.withContext(userCtx("acme"), (q) =>
      q.query("UPDATE invoices SET client_name = 'PWNED' WHERE id = $1", [victim]),
    );
    expect(upd.rowCount).toBe(0);

    const del = await h.db.withContext(userCtx("acme"), (q) =>
      q.query("DELETE FROM invoices WHERE id = $1", [victim]),
    );
    expect(del.rowCount).toBe(0);

    const bulk = await h.db.withContext(userCtx("acme"), (q) =>
      q.query("DELETE FROM invoices WHERE tenant_id = $1", [h.ids.tenants.smith]),
    );
    expect(bulk.rowCount).toBe(0);

    const check = await h.db.privileged((q) =>
      q.query<{ client_name: string }>("SELECT client_name FROM invoices WHERE id = $1", [victim]),
    );
    expect(check.rows[0]!.client_name).not.toBe("PWNED");
  });

  it("a tenant user cannot INSERT or UPDATE rows in users / tenants", async () => {
    await expect(
      h.db.withContext(userCtx("acme"), (q) =>
        q.query(
          `INSERT INTO users (email, password_hash, name, role, tenant_id)
             VALUES ('mallory@acme.test', 'x', 'Mallory', 'admin', NULL)`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    const renameTenant = await h.db.withContext(userCtx("acme"), (q) =>
      q.query("UPDATE tenants SET name = 'Hacme' WHERE id = $1", [h.ids.tenants.acme]),
    );
    expect(renameTenant.rowCount).toBe(0);
  });

  it("control: an admin context can perform the same writes in any tenant", async () => {
    const ins = await h.db.withContext(adminCtx(), (q) =>
      q.query<{ id: string }>(
        `INSERT INTO invoices (tenant_id, number, client_name, amount_cents)
           VALUES ($1, 'ADM-RLS', 'ok', 1) RETURNING id`,
        [h.ids.tenants.smith],
      ),
    );
    const id = ins.rows[0]!.id;

    const upd = await h.db.withContext(adminCtx(), (q) =>
      q.query("UPDATE invoices SET client_name = 'ok2' WHERE id = $1", [id]),
    );
    expect(upd.rowCount).toBe(1);

    const del = await h.db.withContext(adminCtx(), (q) =>
      q.query("DELETE FROM invoices WHERE id = $1", [id]),
    );
    expect(del.rowCount).toBe(1);
  });
});
