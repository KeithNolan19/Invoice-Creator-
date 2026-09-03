import { config } from "../config.ts";
import { PgDb } from "./pg.ts";
import { migrate } from "./migrator.ts";
import { seed, SEED_PASSWORD } from "./seed.ts";

const db = new PgDb(config.adminDatabaseUrl || config.databaseUrl);
try {
  await migrate(db);
  const result = await seed(db);
  console.log(
    `Seeded ${result.tenants} tenants, ${result.users} users, ${result.invoices} invoices.`,
  );
  console.log(`All seeded accounts use password: ${SEED_PASSWORD}`);
} finally {
  await db.close();
}
