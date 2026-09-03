import type { Express } from "express";
import supertest from "supertest";
import { hashPassword } from "../../src/auth/password.ts";
import { signAccessToken } from "../../src/auth/tokens.ts";
import { migrate } from "../../src/db/migrator.ts";
import { seed, SEED_PASSWORD } from "../../src/db/seed.ts";
import { createApp } from "../../src/http/app.ts";
import { PgliteDb } from "./pglite-db.ts";

export const ACCOUNTS = {
  alice: "alice@acme.test",
  bob: "bob@smith.test",
  admin: "admin@invoicecreator.test",
} as const;

type AccountKey = keyof typeof ACCOUNTS;

export interface HarnessState {
  tokens: Record<AccountKey, string>;
  ids: {
    tenants: { acme: string; smith: string };
    users: Record<AccountKey, string>;
    invoices: { acme: string[]; smith: string[] };
  };
}

export interface ExtraUser {
  id: string;
  email: string;
  token: string;
}

export interface Harness extends HarnessState {
  db: PgliteDb;
  app: Express;
  api: ReturnType<typeof supertest>;
  /** Wipe all tenant data, re-seed, and refresh `ids` / `tokens` in place. */
  reload(): Promise<void>;
  /**
   * Insert an extra tenant user (default: a `member`) and mint a token for it.
   * Used by Stage-1 tests that need a non-admin tenant member without changing
   * the seed (which the existing suites assert against).
   */
  createUser(opts: {
    tenant: "acme" | "smith";
    tenantRole?: "admin" | "member";
    email?: string;
  }): Promise<ExtraUser>;
  close(): Promise<void>;
}

const TENANT_TABLES =
  "admin_notifications, platform_payment_events, platform_payments, platform_invoices, " +
  "tenant_subscriptions, support_messages, support_tickets, audit_logs, invoice_line_items, " +
  "invoices, tenant_payment_integrations, tenant_settings, customers, users, tenants";

let cachedHash: Promise<string> | null = null;
const seedHash = () => (cachedHash ??= hashPassword(SEED_PASSWORD));

async function seedAndResolve(db: PgliteDb): Promise<HarnessState> {
  await seed(db);

  const { tenants, users, invoices } = await db.privileged(async (q) => {
    const t = await q.query<{ slug: string; id: string }>("SELECT slug, id FROM tenants");
    const u = await q.query<{ email: string; id: string }>("SELECT email, id FROM users");
    const inv = await q.query<{ id: string; tenant_id: string }>(
      "SELECT id, tenant_id FROM invoices",
    );
    return { tenants: t.rows, users: u.rows, invoices: inv.rows };
  });

  const tenantBySlug = Object.fromEntries(tenants.map((r) => [r.slug, r.id])) as Record<string, string>;
  const userByEmail = Object.fromEntries(users.map((r) => [r.email, r.id])) as Record<string, string>;
  const userIds = {
    alice: userByEmail[ACCOUNTS.alice]!,
    bob: userByEmail[ACCOUNTS.bob]!,
    admin: userByEmail[ACCOUNTS.admin]!,
  };

  return {
    tokens: {
      alice: signAccessToken(userIds.alice),
      bob: signAccessToken(userIds.bob),
      admin: signAccessToken(userIds.admin),
    },
    ids: {
      tenants: { acme: tenantBySlug.acme!, smith: tenantBySlug.smith! },
      users: userIds,
      invoices: {
        acme: invoices.filter((r) => r.tenant_id === tenantBySlug.acme).map((r) => r.id),
        smith: invoices.filter((r) => r.tenant_id === tenantBySlug.smith).map((r) => r.id),
      },
    },
  };
}

export async function createHarness(): Promise<Harness> {
  const db = new PgliteDb();
  await migrate(db);

  const app = createApp(db);
  const api = supertest(app);

  const harness: Harness = {
    db,
    app,
    api,
    ...(await seedAndResolve(db)),
    async reload() {
      await db.privileged((q) =>
        q.exec(`TRUNCATE ${TENANT_TABLES} RESTART IDENTITY CASCADE`),
      );
      const next = await seedAndResolve(db);
      harness.tokens = next.tokens;
      harness.ids = next.ids;
    },
    async createUser({ tenant, tenantRole = "member", email }) {
      const addr = email ?? `${tenantRole}-${Math.random().toString(36).slice(2, 8)}@${tenant}.test`;
      const hash = await seedHash();
      const id = await db.privileged(async (q) => {
        const { rows } = await q.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, name, role, tenant_id, tenant_role)
           VALUES ($1, $2, $3, 'user', $4, $5) RETURNING id`,
          [addr, hash, `User ${addr}`, harness.ids.tenants[tenant], tenantRole],
        );
        return rows[0]!.id;
      });
      return { id, email: addr, token: signAccessToken(id) };
    },
    close: () => db.close(),
  };
  return harness;
}

/** `auth(token)` -> header tuple for `.set(...)`. */
export function auth(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}
