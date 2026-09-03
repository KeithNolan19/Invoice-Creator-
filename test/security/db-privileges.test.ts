import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RlsContext } from "../../src/db/types.ts";
import { createHarness, type Harness } from "../support/harness.ts";

/** Requirement 7 — database security: roles, grants and RLS policies. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const acme = (): RlsContext => ({ userId: h.ids.users.alice, tenantId: h.ids.tenants.acme, isAdmin: false });
const smith = (): RlsContext => ({ userId: h.ids.users.bob, tenantId: h.ids.tenants.smith, isAdmin: false });
const noCtx = (): RlsContext => ({ userId: h.ids.users.alice, tenantId: null, isAdmin: false });

describe("the app connects with least privilege, not a superuser", () => {
  it("invoice_app_login: not superuser, not BYPASSRLS, member of invoice_app + invoice_auth", async () => {
    const { rows } = await h.db.privileged((q) =>
      q.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'invoice_app_login'",
      ),
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    const members = await h.db.privileged((q) =>
      q.query<{ role: string }>(
        `SELECT g.rolname AS role
           FROM pg_auth_members m
           JOIN pg_roles g ON g.oid = m.roleid
           JOIN pg_roles u ON u.oid = m.member
          WHERE u.rolname = 'invoice_app_login'`,
      ),
    );
    expect(members.rows.map((r) => r.role).sort()).toEqual(["invoice_app", "invoice_auth"]);
  });

  it("invoice_app is RLS-subject; only invoice_auth carries BYPASSRLS", async () => {
    const { rows } = await h.db.privileged((q) =>
      q.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('invoice_app','invoice_auth') ORDER BY rolname",
      ),
    );
    expect(rows).toEqual([
      { rolname: "invoice_app", rolsuper: false, rolbypassrls: false },
      { rolname: "invoice_auth", rolsuper: false, rolbypassrls: true },
    ]);
  });
});

describe("invoice_auth (pre-auth lookup role) is narrow", () => {
  it("can read users and tenants", async () => {
    const r = await h.db.bypassRls(async (q) => ({
      users: (await q.query("SELECT id FROM users")).rows.length,
      tenants: (await q.query("SELECT id FROM tenants")).rows.length,
    }));
    expect(r.users).toBeGreaterThan(0);
    expect(r.tenants).toBe(2);
  });

  it("cannot read invoices or audit_logs", async () => {
    await expect(h.db.bypassRls((q) => q.query("SELECT * FROM invoices"))).rejects.toThrow(/permission denied/i);
    await expect(h.db.bypassRls((q) => q.query("SELECT * FROM audit_logs"))).rejects.toThrow(/permission denied/i);
  });

  it("cannot write to users or tenants", async () => {
    await expect(
      h.db.bypassRls((q) => q.query("UPDATE users SET name = 'x' WHERE id = $1", [h.ids.users.alice])),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      h.db.bypassRls((q) => q.query("UPDATE tenants SET name = 'x' WHERE id = $1", [h.ids.tenants.acme])),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("tenant users cannot write to tenants / users / audit_logs", () => {
  const attempts: Array<[string, string, unknown[]]> = [
    ["INSERT tenants", "INSERT INTO tenants (name, slug) VALUES ('x','x-slug')", []],
    ["UPDATE tenants", "UPDATE tenants SET name = 'HACKED' WHERE id = $1", []],
    ["DELETE tenants", "DELETE FROM tenants WHERE id = $1", []],
    ["INSERT users", "INSERT INTO users (email, password_hash, name, role, tenant_id) VALUES ('x@x.test','x','X','admin',NULL)", []],
    ["UPDATE users role", "UPDATE users SET role = 'admin' WHERE id = $1", []],
    ["DELETE users", "DELETE FROM users WHERE id = $1", []],
    ["INSERT audit_logs", "INSERT INTO audit_logs (actor_user_id, action) VALUES ($1, 'forged')", []],
    ["UPDATE audit_logs", "UPDATE audit_logs SET action = 'x'", []],
    ["DELETE audit_logs", "DELETE FROM audit_logs", []],
  ];

  it("every write attempt in a tenant context is rejected or affects zero rows", async () => {
    for (const [label, sql] of attempts) {
      const param =
        sql.includes("tenants SET") || sql.includes("FROM tenants") ? h.ids.tenants.acme : h.ids.users.alice;
      let rowCount = -1;
      let threw = false;
      try {
        const res = await h.db.withContext(acme(), (q) =>
          q.query(sql, sql.includes("$1") ? [param] : []),
        );
        rowCount = res.rowCount;
      } catch {
        threw = true;
      }
      expect(threw || rowCount === 0, label).toBe(true);
    }

    // nothing actually changed
    const check = await h.db.privileged(async (q) => ({
      acmeName: (await q.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [h.ids.tenants.acme])).rows[0]!.name,
      aliceRole: (await q.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [h.ids.users.alice])).rows[0]!.role,
    }));
    expect(check.acmeName).toBe("Acme Ltd");
    expect(check.aliceRole).toBe("user");
  });
});

describe("tenant-owned tables fail closed and enforce WITH CHECK / DELETE policies", () => {
  it("no tenant context => zero rows everywhere", async () => {
    const counts = await h.db.withContext(noCtx(), async (q) => ({
      invoices: (await q.query("SELECT * FROM invoices")).rows.length,
      users: (await q.query("SELECT * FROM users")).rows.length,
      tenants: (await q.query("SELECT * FROM tenants")).rows.length,
      audit: (await q.query("SELECT * FROM audit_logs")).rows.length,
    }));
    expect(counts).toEqual({ invoices: 0, users: 0, tenants: 0, audit: 0 });
  });

  it("WITH CHECK blocks creating or moving an invoice into another tenant", async () => {
    await expect(
      h.db.withContext(acme(), (q) =>
        q.query(
          "INSERT INTO invoices (tenant_id, number, client_name, amount_cents) VALUES ($1,'X','x',1)",
          [h.ids.tenants.smith],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      h.db.withContext(acme(), (q) =>
        q.query("UPDATE invoices SET tenant_id = $1 WHERE id = $2", [
          h.ids.tenants.smith,
          h.ids.invoices.acme[0],
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("DELETE policy prevents cross-tenant deletion", async () => {
    const before = h.ids.invoices.smith.length;
    const res = await h.db.withContext(acme(), (q) =>
      q.query("DELETE FROM invoices WHERE tenant_id = $1", [h.ids.tenants.smith]),
    );
    expect(res.rowCount).toBe(0);
    const after = await h.db.withContext(smith(), (q) => q.query("SELECT id FROM invoices"));
    expect(after.rows.length).toBe(before);
  });
});
