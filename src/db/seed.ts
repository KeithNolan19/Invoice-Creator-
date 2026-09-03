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
}

const TENANTS: SeedTenant[] = [
  { slug: "acme", name: "Acme Ltd" },
  { slug: "smith", name: "Smith Ltd" },
];

const USERS: SeedUser[] = [
  { email: "alice@acme.test", name: "Alice Anderson", role: "user", tenantSlug: "acme" },
  { email: "bob@smith.test", name: "Bob Barker", role: "user", tenantSlug: "smith" },
  { email: "admin@invoicecreator.test", name: "Platform Admin", role: "admin", tenantSlug: null },
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

  const passwordHash = await hashPassword(SEED_PASSWORD);
  const userIds = new Map<string, string>();
  for (const u of USERS) {
    const tenantId = u.tenantSlug ? tenantIds.get(u.tenantSlug)! : null;
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, role, tenant_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE
         SET name = EXCLUDED.name, role = EXCLUDED.role, tenant_id = EXCLUDED.tenant_id
       RETURNING id`,
      [u.email, passwordHash, u.name, u.role, tenantId],
    );
    userIds.set(u.email, rows[0]!.id);
  }

  const acmeCreator = userIds.get("alice@acme.test")!;
  const smithCreator = userIds.get("bob@smith.test")!;
  for (const inv of INVOICES) {
    const tenantId = tenantIds.get(inv.tenantSlug)!;
    const createdBy = inv.tenantSlug === "acme" ? acmeCreator : smithCreator;
    await q.query(
      `INSERT INTO invoices (tenant_id, number, client_name, amount_cents, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, number) DO UPDATE
         SET client_name = EXCLUDED.client_name,
             amount_cents = EXCLUDED.amount_cents,
             status = EXCLUDED.status`,
      [tenantId, inv.number, inv.client, inv.cents, inv.status, createdBy],
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
