import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrator.ts";
import { seed } from "../src/db/seed.ts";
import type { RlsContext } from "../src/db/types.ts";
import { PgliteDb } from "./support/pglite-db.ts";

let db: PgliteDb;
let acme: string;
let smith: string;

beforeAll(async () => {
  db = new PgliteDb();
  await migrate(db);
  await seed(db);
  const ids = await db.privileged(async (q) => {
    const { rows } = await q.query<{ slug: string; id: string }>("SELECT slug, id FROM tenants");
    return Object.fromEntries(rows.map((r) => [r.slug, r.id])) as Record<string, string>;
  });
  acme = ids.acme!;
  smith = ids.smith!;
});
afterAll(() => db.close());

const ctx = (tenantId: string | null, isAdmin = false): RlsContext => ({
  userId: "00000000-0000-0000-0000-000000000000",
  tenantId,
  isAdmin,
});

describe("Row-Level Security is enforced by the database", () => {
  it("privileged access bypasses RLS and sees every tenant", async () => {
    const all = await db.privileged((q) => q.query<{ n: string }>("SELECT count(*) n FROM invoices"));
    expect(Number(all.rows[0]!.n)).toBeGreaterThanOrEqual(3);
  });

  it("a tenant context sees only its own rows", async () => {
    const acmeRows = await db.withContext(ctx(acme), (q) =>
      q.query<{ tenant_id: string }>("SELECT tenant_id FROM invoices"),
    );
    expect(acmeRows.rows.length).toBeGreaterThan(0);
    expect(acmeRows.rows.every((r) => r.tenant_id === acme)).toBe(true);

    const smithRows = await db.withContext(ctx(smith), (q) =>
      q.query<{ tenant_id: string }>("SELECT tenant_id FROM invoices"),
    );
    expect(smithRows.rows.every((r) => r.tenant_id === smith)).toBe(true);
  });

  it("an admin context sees rows from all tenants", async () => {
    const rows = await db.withContext(ctx(null, true), (q) =>
      q.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM invoices"),
    );
    const seen = rows.rows.map((r) => r.tenant_id).sort();
    expect(seen).toEqual([acme, smith].sort());
  });

  it("fails closed: an unknown tenant context sees nothing", async () => {
    const rows = await db.withContext(ctx("11111111-1111-1111-1111-111111111111"), (q) =>
      q.query("SELECT * FROM invoices"),
    );
    expect(rows.rows.length).toBe(0);
  });

  it("blocks cross-tenant INSERT via the WITH CHECK policy", async () => {
    await expect(
      db.withContext(ctx(acme), (q) =>
        q.query(
          `INSERT INTO invoices (tenant_id, number, client_name, amount_cents)
           VALUES ($1, 'HACK-1', 'X', 1)`,
          [smith],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("blocks cross-tenant UPDATE (row is invisible, so nothing is changed)", async () => {
    const smithInvoice = await db.privileged((q) =>
      q.query<{ id: string }>("SELECT id FROM invoices WHERE tenant_id = $1 LIMIT 1", [smith]),
    );
    const targetId = smithInvoice.rows[0]!.id;

    const updated = await db.withContext(ctx(acme), (q) =>
      q.query("UPDATE invoices SET client_name = 'PWNED' WHERE id = $1", [targetId]),
    );
    expect(updated.rowCount).toBe(0);

    const check = await db.privileged((q) =>
      q.query<{ client_name: string }>("SELECT client_name FROM invoices WHERE id = $1", [targetId]),
    );
    expect(check.rows[0]!.client_name).not.toBe("PWNED");
  });
});
