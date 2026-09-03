import { hashPassword } from "../auth/password.ts";
import type { Db, Queryable } from "./types.ts";

/** Password for every seeded account (development only). */
export const SEED_PASSWORD = "Password123!";

interface SeedTenant {
  slug: string;
  name: string;
}

interface SeedUser {
  email: string;
  name: string;
  role: "user" | "admin";
  tenantSlug: string | null;
  tenantRole: "admin" | "member" | null;
}

const TENANTS: SeedTenant[] = [
  { slug: "acme", name: "Acme Ltd" },
  { slug: "smith", name: "Smith Ltd" },
];

const USERS: SeedUser[] = [
  { email: "alice@acme.test", name: "Alice Anderson", role: "user", tenantSlug: "acme", tenantRole: "admin" },
  { email: "bob@smith.test", name: "Bob Barker", role: "user", tenantSlug: "smith", tenantRole: "admin" },
  { email: "admin@invoicecreator.test", name: "Platform Admin", role: "admin", tenantSlug: null, tenantRole: null },
];

const INVOICES: Array<{ tenantSlug: string; number: string; client: string; cents: number; status: string }> = [
  { tenantSlug: "acme", number: "ACME-0001", client: "Globex Corporation", cents: 120_00, status: "sent" },
  { tenantSlug: "acme", number: "ACME-0002", client: "Initech", cents: 4_500_00, status: "draft" },
  { tenantSlug: "smith", number: "SMITH-0001", client: "Wonka Industries", cents: 999_00, status: "paid" },
];

async function seedWith(q: Queryable): Promise<void> {
  const tenantIds = new Map<string, string>();
  for (const t of TENANTS) {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [t.name, t.slug],
    );
    tenantIds.set(t.slug, rows[0]!.id);
  }

  // One tenant_settings row per tenant (the migration backfills the same for
  // pre-existing tenants; this covers a re-seed after TRUNCATE).
  for (const t of TENANTS) {
    await q.query(
      `INSERT INTO tenant_settings (tenant_id, business_name)
       VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantIds.get(t.slug)!, t.name],
    );
  }

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const userIds = new Map<string, string>();
  for (const u of USERS) {
    const tenantId = u.tenantSlug ? tenantIds.get(u.tenantSlug)! : null;
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, role, tenant_id, tenant_role)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, role = EXCLUDED.role,
             tenant_id = EXCLUDED.tenant_id, tenant_role = EXCLUDED.tenant_role
       RETURNING id`,
      [u.email, passwordHash, u.name, u.role, tenantId, u.tenantRole],
    );
    userIds.set(u.email, rows[0]!.id);
  }

  const acmeCreator = userIds.get("alice@acme.test")!;
  const smithCreator = userIds.get("bob@smith.test")!;
  for (const inv of INVOICES) {
    const tenantId = tenantIds.get(inv.tenantSlug)!;
    const createdBy = inv.tenantSlug === "acme" ? acmeCreator : smithCreator;
    const paid = inv.status === "paid";
    await q.query(
      `INSERT INTO invoices
         (tenant_id, number, client_name, amount_cents, currency, status, created_by,
          subtotal_cents, total_cents, payment_status,
          paid_at, paid_amount_cents, paid_currency)
       VALUES ($1, $2, $3, $4, 'USD', $5, $6, $4, $4, $7, $8, $9, $10)
       ON CONFLICT (tenant_id, number) DO UPDATE
         SET client_name = EXCLUDED.client_name,
             amount_cents = EXCLUDED.amount_cents,
             status = EXCLUDED.status,
             payment_status = EXCLUDED.payment_status`,
      [
        tenantId,
        inv.number,
        inv.client,
        inv.cents,
        inv.status,
        createdBy,
        paid ? "paid" : "unpaid",
        paid ? new Date() : null,
        paid ? inv.cents : null,
        paid ? "USD" : null,
      ],
    );
  }
}

export interface SeedResult {
  tenants: number;
  users: number;
  invoices: number;
}

export async function seed(db: Db): Promise<SeedResult> {
  await db.privileged(seedWith);
  return { tenants: TENANTS.length, users: USERS.length, invoices: INVOICES.length };
}
