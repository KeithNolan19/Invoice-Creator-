import { PGlite } from "@electric-sql/pglite";
import { config } from "../../src/config.ts";
import type { Db, Queryable, QueryResult, RlsContext } from "../../src/db/types.ts";

/**
 * In-process PGlite implementation of the `Db` seam for tests. PGlite is a
 * single session, so every operation is serialized through a promise queue to
 * keep transactions from interleaving.
 */
export class PgliteDb implements Db {
  private readonly pg = new PGlite();
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = this.queue.then(op, op);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private wrap(): Queryable {
    return {
      query: async <T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> => {
        const res = await this.pg.query<T>(text, params as unknown[]);
        return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
      },
      exec: async (sql: string): Promise<void> => {
        await this.pg.exec(sql);
      },
    };
  }

  privileged<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.serialize(() => fn(this.wrap()));
  }

  bypassRls<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const q = this.wrap();
      await q.exec("BEGIN");
      try {
        await q.exec(`SET LOCAL ROLE ${config.authDbRole}`);
        const result = await fn(q);
        await q.exec("COMMIT");
        return result;
      } catch (err) {
        await q.exec("ROLLBACK").catch(() => undefined);
        throw err;
      }
    });
  }

  withContext<T>(ctx: RlsContext, fn: (q: Queryable) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const q = this.wrap();
      await q.exec("BEGIN");
      try {
        await q.exec(`SET LOCAL ROLE ${config.appDbRole}`);
        await q.query("SELECT set_config('app.current_tenant', $1, true)", [ctx.tenantId ?? ""]);
        await q.query("SELECT set_config('app.is_admin', $1, true)", [ctx.isAdmin ? "true" : "false"]);
        await q.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.userId]);
        const result = await fn(q);
        await q.exec("COMMIT");
        return result;
      } catch (err) {
        await q.exec("ROLLBACK").catch(() => undefined);
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.serialize(() => this.pg.close());
  }
}
