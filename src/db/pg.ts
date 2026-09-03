import pg from "pg";
import { config } from "../config.ts";
import type { Db, Queryable, QueryResult, RlsContext } from "./types.ts";

// Return DECIMAL/NUMERIC as-is (string) and BIGINT as string; callers convert
// explicitly. Amounts are stored as BIGINT cents.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => v);

function wrap(client: pg.PoolClient): Queryable {
  return {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      const res = await client.query(text, params as unknown[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },
  };
}

export class PgDb implements Db {
  private readonly pool: pg.Pool;

  constructor(connectionString: string = config.databaseUrl) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async privileged<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(wrap(client));
    } finally {
      client.release();
    }
  }

  async bypassRls<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL ROLE ${config.authDbRole}`);
      const result = await fn(wrap(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async withContext<T>(ctx: RlsContext, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Drop to the unprivileged role so RLS policies apply for this transaction.
      await client.query(`SET LOCAL ROLE ${config.appDbRole}`);
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [ctx.tenantId ?? ""]);
      await client.query("SELECT set_config('app.is_admin', $1, true)", [ctx.isAdmin ? "true" : "false"]);
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.userId]);
      const result = await fn(wrap(client));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
