import { PgDb } from "../db/pg.ts";
import { runBillingTick } from "../billing/billing-tick.ts";

// One pass of the time-based billing work (renewals, overdue, reconciliation).
// Run on a schedule by deploy/invoice-billing.timer. Idempotent — see
// src/billing/billing-tick.ts.

const db = new PgDb();
try {
  const result = await runBillingTick(db);
  console.log(`billing-tick ${new Date().toISOString()}: ${JSON.stringify(result)}`);
  if (result.errors.length > 0) process.exitCode = 1;
} catch (err) {
  console.error("billing-tick failed:", err);
  process.exitCode = 1;
} finally {
  await db.close();
}
