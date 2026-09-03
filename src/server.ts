import { config } from "./config.ts";
import { PgDb } from "./db/pg.ts";
import { migrate } from "./db/migrator.ts";
import { createApp } from "./http/app.ts";

async function main(): Promise<void> {
  const db = new PgDb();

  if (config.isProduction) {
    // Production migrates as a separate deploy step, run by an admin/owner role
    // (the app role is not allowed to run DDL). See docs/DEPLOYMENT.md.
    console.log("Production mode: skipping auto-migrate. Run `npm run migrate` during deploy.");
  } else {
    const applied = await migrate(db);
    const fresh = applied.filter((m) => !m.alreadyApplied);
    console.log(
      fresh.length > 0
        ? `Applied ${fresh.length} migration(s): ${fresh.map((m) => m.name).join(", ")}`
        : "Database schema up to date",
    );
  }

  const app = createApp(db);
  const server = app.listen(config.port, () => {
    console.log(`Invoice Creator API listening on http://localhost:${config.port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n${signal} received, shutting down`);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
