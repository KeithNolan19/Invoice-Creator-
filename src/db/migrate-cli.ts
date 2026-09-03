import { config } from "../config.ts";
import { PgDb } from "./pg.ts";
import { migrate } from "./migrator.ts";

// Migrations run as the admin/owner role, not the app role.
const db = new PgDb(config.adminDatabaseUrl || config.databaseUrl);
try {
  const applied = await migrate(db);
  for (const m of applied) {
    console.log(`${m.alreadyApplied ? "= " : "+ "}${m.name}`);
  }
  console.log("Migrations complete.");
} finally {
  await db.close();
}
