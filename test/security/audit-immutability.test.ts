import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RlsContext } from "../../src/db/types.ts";
import { auth, createHarness, type Harness } from "../support/harness.ts";

/** Requirement 4 — audit_logs is genuinely append-only. */

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reload());

const admin = () => auth(h.tokens.admin);
const adminCtx = (): RlsContext => ({ userId: h.ids.users.admin, tenantId: null, isAdmin: true });

async function seedOneAuditRow() {
  await h.api.post("/api/admin/tenants").set(...admin()).send({ name: "Audit Co" });
}

describe("no role can UPDATE or DELETE an audit record", () => {
  beforeEach(seedOneAuditRow);

  it("the admin context cannot UPDATE or DELETE audit_logs", async () => {
    await expect(
      h.db.withContext(adminCtx(), (q) => q.query("UPDATE audit_logs SET action = 'tampered'")),
    ).rejects.toThrow();
    await expect(
      h.db.withContext(adminCtx(), (q) => q.query("DELETE FROM audit_logs")),
    ).rejects.toThrow();
  });

  it("even a privileged (superuser) connection is blocked by the trigger", async () => {
    await expect(
      h.db.privileged((q) => q.query("UPDATE audit_logs SET action = 'tampered'")),
    ).rejects.toThrow(/append-only/i);
    await expect(
      h.db.privileged((q) => q.query("DELETE FROM audit_logs")),
    ).rejects.toThrow(/append-only/i);
  });

  it("the record is unchanged after the failed tamper attempts", async () => {
    const { rows } = await h.db.privileged((q) =>
      q.query<{ action: string }>("SELECT action FROM audit_logs"),
    );
    expect(rows.every((r) => r.action !== "tampered")).toBe(true);
    expect(rows.length).toBe(1);
  });
});

describe("tenant users are completely shut out of audit_logs", () => {
  beforeEach(seedOneAuditRow);

  it("cannot SELECT / INSERT / UPDATE / DELETE", async () => {
    const ctx: RlsContext = { userId: h.ids.users.alice, tenantId: h.ids.tenants.acme, isAdmin: false };
    const sel = await h.db.withContext(ctx, (q) => q.query("SELECT * FROM audit_logs"));
    expect(sel.rows.length).toBe(0);

    for (const sql of [
      "INSERT INTO audit_logs (actor_user_id, action) VALUES (null, 'forged')",
      "UPDATE audit_logs SET action = 'x'",
      "DELETE FROM audit_logs",
    ]) {
      let blocked = false;
      try {
        const r = await h.db.withContext(ctx, (q) => q.query(sql));
        blocked = r.rowCount === 0;
      } catch {
        blocked = true;
      }
      expect(blocked, sql).toBe(true);
    }
  });

  it("the admin API audit-log endpoint is not reachable by tenant users", async () => {
    expect((await h.api.get("/api/admin/audit-logs").set(...auth(h.tokens.alice))).status).toBe(403);
  });
});

describe("audit records are written transactionally with the change", () => {
  it("a failed admin mutation leaves no audit row", async () => {
    const dup = await h.api.post("/api/admin/tenants").set(...admin()).send({ name: "Acme copy", slug: "acme" });
    expect(dup.status).toBe(409);
    const audit = await h.api.get("/api/admin/audit-logs").set(...admin());
    expect(audit.body.auditLogs).toHaveLength(0);
  });

  it("a successful admin mutation always leaves exactly one matching audit row", async () => {
    const created = await h.api.post("/api/admin/tenants").set(...admin()).send({ name: "Lifecycle Co" });
    const tid = created.body.tenant.id;

    const u = await h.api.post(`/api/admin/tenants/${tid}/users`).set(...admin()).send({ name: "L", email: "l@life.test" });
    const uid = u.body.user.id;

    await h.api.post(`/api/admin/tenants/${tid}/suspend`).set(...admin());
    await h.api.post(`/api/admin/tenants/${tid}/reactivate`).set(...admin());
    await h.api.post(`/api/admin/users/${uid}/disable`).set(...admin());
    await h.api.post(`/api/admin/users/${uid}/enable`).set(...admin());

    const { auditLogs } = (await h.api.get("/api/admin/audit-logs").set(...admin())).body;
    expect(auditLogs.map((e: any) => e.action).sort()).toEqual(
      [
        "tenant.created",
        "tenant.reactivated",
        "tenant.suspended",
        "user.created",
        "user.disabled",
        "user.enabled",
      ].sort(),
    );
    // who / what / which tenant / when
    for (const e of auditLogs) {
      expect(e.actor.email).toBe("admin@invoicecreator.test");
      expect(e.tenant.id).toBe(tid);
      expect(Number.isFinite(new Date(e.createdAt).getTime())).toBe(true);
    }
  });
});
