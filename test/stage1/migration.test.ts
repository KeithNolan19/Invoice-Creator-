import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.ts";
import { seed } from "../../src/db/seed.ts";
import { PgliteDb } from "../support/pglite-db.ts";

/** Stage 1 — migration 008 applies cleanly and backfills existing data safely. */

let db: PgliteDb | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

describe("008_customer_journey_foundations applies", () => {
  it("runs in order after 007 and creates the new tables, functions and policies", async () => {
    db = new PgliteDb();
    const applied = await migrate(db);
    const names = applied.map((m) => m.name);
    expect(names).toContain("008_customer_journey_foundations.sql");
    // 008 applies immediately after 007 (later migrations may follow).
    expect(names.indexOf("008_customer_journey_foundations.sql")).toBe(
      names.indexOf("007_least_privilege_roles.sql") + 1,
    );

    const shape = await db.privileged(async (q) => ({
      tables: (
        await q.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN ('customers','invoice_line_items','tenant_settings','tenant_payment_integrations')
            ORDER BY table_name`,
        )
      ).rows.map((r) => r.table_name),
      rlsEnabled: (
        await q.query<{ relname: string }>(
          `SELECT relname FROM pg_class
            WHERE relrowsecurity AND relname IN
              ('customers','invoice_line_items','tenant_settings','tenant_payment_integrations')
            ORDER BY relname`,
        )
      ).rows.map((r) => r.relname),
      functions: (
        await q.query<{ proname: string }>(
          `SELECT proname FROM pg_proc WHERE proname IN ('app_tenant_role','allocate_invoice_number') ORDER BY proname`,
        )
      ).rows.map((r) => r.proname),
      invoiceCols: (
        await q.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'invoices'
              AND column_name IN ('payment_status','payment_provider','payment_reference',
                                  'fire_payment_code','paid_at','paid_amount_cents','paid_currency',
                                  'total_cents','customer_id','business_snapshot')
            ORDER BY column_name`,
        )
      ).rows.map((r) => r.column_name),
    }));

    expect(shape.tables).toEqual([
      "customers",
      "invoice_line_items",
      "tenant_payment_integrations",
      "tenant_settings",
    ]);
    expect(shape.rlsEnabled).toEqual([
      "customers",
      "invoice_line_items",
      "tenant_payment_integrations",
      "tenant_settings",
    ]);
    expect(shape.functions).toEqual(["allocate_invoice_number", "app_tenant_role"]);
    expect(shape.invoiceCols).toHaveLength(10);
  });

  it("is idempotent on a second run", async () => {
    db = new PgliteDb();
    await migrate(db);
    const again = await migrate(db);
    expect(again.every((m) => m.alreadyApplied)).toBe(true);
  });
});

describe("backfill of pre-existing data (safest strategy)", () => {
  it("promotes every existing tenant user to tenant admin, leaves platform admins null", async () => {
    db = new PgliteDb();
    await migrate(db, { upTo: "007" });

    const legacyTenant = await db.privileged(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        "INSERT INTO tenants (name, slug) VALUES ('Legacy Co', 'legacy') RETURNING id",
      );
      const tid = rows[0]!.id;
      await q.query(
        `INSERT INTO users (email, password_hash, name, role, tenant_id)
         VALUES ('one@legacy.test','h','One','user',$1), ('two@legacy.test','h','Two','user',$1)`,
        [tid],
      );
      await q.query(
        `INSERT INTO users (email, password_hash, name, role, tenant_id)
         VALUES ('root@platform.test','h','Root','admin',NULL)`,
      );
      await q.query(
        `INSERT INTO invoices (tenant_id, number, client_name, amount_cents, status)
         VALUES ($1,'LEG-1','Client',777,'paid'), ($1,'LEG-2','Client',100,'sent')`,
        [tid],
      );
      return tid;
    });

    await migrate(db); // applies 008

    const after = await db.privileged(async (q) => ({
      users: (
        await q.query<{ email: string; tenant_role: string | null }>(
          "SELECT email, tenant_role FROM users ORDER BY email",
        )
      ).rows,
      settings: (
        await q.query<{ n: number }>("SELECT count(*)::int n FROM tenant_settings WHERE tenant_id = $1", [
          legacyTenant,
        ])
      ).rows[0]!.n,
      invoices: (
        await q.query<{ number: string; payment_status: string; total_cents: string; paid_currency: string | null }>(
          "SELECT number, payment_status, total_cents, paid_currency FROM invoices ORDER BY number",
        )
      ).rows,
    }));

    expect(after.users).toEqual([
      { email: "one@legacy.test", tenant_role: "admin" },
      { email: "root@platform.test", tenant_role: null },
      { email: "two@legacy.test", tenant_role: "admin" },
    ]);
    expect(after.settings).toBe(1);

    const leg1 = after.invoices.find((i) => i.number === "LEG-1")!;
    const leg2 = after.invoices.find((i) => i.number === "LEG-2")!;
    expect(leg1.payment_status).toBe("paid");
    expect(Number(leg1.total_cents)).toBe(777);
    expect(leg1.paid_currency).toBe("USD");
    expect(leg2.payment_status).toBe("unpaid");
  });

  it("the new users CHECK rejects a tenant user without a tenant_role and a platform admin with one", async () => {
    db = new PgliteDb();
    await migrate(db);
    const tid = await db.privileged(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        "INSERT INTO tenants (name, slug) VALUES ('T', 't') RETURNING id",
      );
      return rows[0]!.id;
    });
    await expect(
      db.privileged((q) =>
        q.query(
          `INSERT INTO users (email, password_hash, name, role, tenant_id, tenant_role)
           VALUES ('bad1@x.test','h','Bad','user',$1,NULL)`,
          [tid],
        ),
      ),
    ).rejects.toThrow(/users_role_consistency|violates check/i);
    await expect(
      db.privileged((q) =>
        q.query(
          `INSERT INTO users (email, password_hash, name, role, tenant_id, tenant_role)
           VALUES ('bad2@x.test','h','Bad','admin',NULL,'admin')`,
        ),
      ),
    ).rejects.toThrow(/users_role_consistency|violates check/i);
  });
});

describe("constraints & integrity", () => {
  it("a line item cannot reference an invoice from another tenant (composite FK)", async () => {
    db = new PgliteDb();
    await migrate(db);
    await seed(db);
    const { acme, smith, invId } = await db.privileged(async (q) => {
      const t = await q.query<{ slug: string; id: string }>("SELECT slug, id FROM tenants");
      const bySlug = Object.fromEntries(t.rows.map((r) => [r.slug, r.id])) as Record<string, string>;
      const i = await q.query<{ id: string }>("SELECT id FROM invoices WHERE tenant_id = $1 LIMIT 1", [
        bySlug.acme,
      ]);
      return { acme: bySlug.acme!, smith: bySlug.smith!, invId: i.rows[0]!.id };
    });

    // privileged (RLS bypassed) so only the FK can stop this
    await expect(
      db.privileged((q) =>
        q.query(
          `INSERT INTO invoice_line_items (invoice_id, tenant_id, description, quantity, unit_price_cents, line_total_cents)
           VALUES ($1, $2, 'x', 1, 100, 100)`,
          [invId, smith],
        ),
      ),
    ).rejects.toThrow(/foreign key|invoice_line_items_invoice_fk/i);

    // same invoice, correct tenant -> ok
    const ok = await db.privileged((q) =>
      q.query(
        `INSERT INTO invoice_line_items (invoice_id, tenant_id, description, quantity, unit_price_cents, line_total_cents)
         VALUES ($1, $2, 'x', 1, 100, 100) RETURNING id`,
        [invId, acme],
      ),
    );
    expect(ok.rows).toHaveLength(1);
  });

  it("payment_reference is unique per tenant but the same reference is free in another tenant", async () => {
    db = new PgliteDb();
    await migrate(db);
    await seed(db);
    const bySlug = await db.privileged(async (q) => {
      const t = await q.query<{ slug: string; id: string }>("SELECT slug, id FROM tenants");
      return Object.fromEntries(t.rows.map((r) => [r.slug, r.id])) as Record<string, string>;
    });

    await db.privileged((q) =>
      q.query(
        `INSERT INTO invoices (tenant_id, number, client_name, amount_cents, payment_reference)
         VALUES ($1,'R-1','c',100,'REF-SHARED'), ($2,'R-2','c',100,'REF-SHARED')`,
        [bySlug.acme, bySlug.smith],
      ),
    );
    await expect(
      db.privileged((q) =>
        q.query(
          `INSERT INTO invoices (tenant_id, number, client_name, amount_cents, payment_reference)
           VALUES ($1,'R-3','c',100,'REF-SHARED')`,
          [bySlug.acme],
        ),
      ),
    ).rejects.toThrow(/unique|invoices_tenant_payment_reference_uk/i);
  });
});
