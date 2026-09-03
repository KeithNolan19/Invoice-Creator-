import type { Express } from "express";
import supertest from "supertest";
import { signAccessToken } from "../../src/auth/tokens.ts";
import { migrate } from "../../src/db/migrator.ts";
import { seed } from "../../src/db/seed.ts";
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

export interface Harness extends HarnessState {
  db: PgliteDb;
  app: Express;
  api: ReturnType<typeof supertest>;
  /** Wipe all tenant data, re-seed, and refresh `ids` / `tokens` in place. */
  reload(): Promise<void>;
  close(): Promise<void>;
}

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
    // Tokens minted directly — the login/bcrypt path is covered in test/auth.test.ts.
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
        q.exec("TRUNCATE audit_logs, invoices, users, tenants RESTART IDENTITY CASCADE"),
      );
      const next = await seedAndResolve(db);
      harness.tokens = next.tokens;
      harness.ids = next.ids;
    },
    close: () => db.close(),
  };
  return harness;
}

/** `auth(token)` -> header tuple for `.set(...)`. */
export function auth(token: string): [string, string] {
  return ["Authorization", `Bearer ${token}`];
}
