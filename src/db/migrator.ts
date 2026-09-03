import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Db, Queryable } from "./types.ts";

const migrationsDir = fileURLToPath(new URL("./migrations/", import.meta.url));

export interface AppliedMigration {
  name: string;
  alreadyApplied: boolean;
}

async function ensureRegistry(q: Queryable): Promise<void> {
  await q.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export interface MigrateOptions {
  /** Only apply migrations whose 3-digit prefix is <= this (e.g. "007"). For tests. */
  upTo?: string;
}

/** Apply every `NNN_*.sql` file in ./migrations that has not run yet, in order. */
export async function migrate(db: Db, opts: MigrateOptions = {}): Promise<AppliedMigration[]> {
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !opts.upTo || f.slice(0, 3) <= opts.upTo)
    .sort();

  return db.privileged(async (q) => {
    await ensureRegistry(q);
    const { rows } = await q.query<{ name: string }>("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));

    const results: AppliedMigration[] = [];
    for (const name of files) {
      if (done.has(name)) {
        results.push({ name, alreadyApplied: true });
        continue;
      }
      const sql = await readFile(path.join(migrationsDir, name), "utf8");
      await q.exec("BEGIN");
      try {
        await q.exec(sql);
        await q.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await q.exec("COMMIT");
      } catch (err) {
        await q.exec("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }
      results.push({ name, alreadyApplied: false });
    }
    return results;
  });
}
