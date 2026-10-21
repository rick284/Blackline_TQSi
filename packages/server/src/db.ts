/**
 * The database seam. Repositories speak plain Postgres SQL through this tiny interface. Development and tests run it on PGlite
 * (a real Postgres in-process, no install); the hosted app passes the same SQL to a `pg` pool (`openPg`) behind the same methods.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface Db {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run several statements with no parameters (migrations). */
  exec(sql: string): Promise<void>;
  /** Run `fn` in one transaction: all of it applies or none of it does. Transactions are serialised. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openPglite(dataDir?: string): Promise<Db> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const wrap = (q: Pick<PGlite, "query" | "exec">): Pick<Db, "query" | "exec"> => ({
    query: async <T,>(sql: string, params?: unknown[]) => ({ rows: (await q.query<T>(sql, params as any[])).rows }),
    exec: async (sql: string) => {
      await q.exec(sql);
    },
  });
  const db: Db = {
    ...wrap(pg),
    tx: (fn) =>
      pg.transaction(async (t) => {
        const inner: Db = { ...wrap(t), tx: (f) => f(inner), close: async () => {} };
        return fn(inner);
      }),
    close: () => pg.close(),
  };
  return db;
}

/**
 * The same seam on a real Postgres (a pool of connections), for the hosted app. `url` is the usual connection string
 * (postgres://user:password@host:5432/dbname?sslmode=require). A transaction takes one connection for its whole length; a plain query borrows one
 * for an instant. Unlike PGlite, transactions here do overlap, which is what the row locks (`select ... for update`) in the repositories are for.
 */
export async function openPg(url: string, opts: { max?: number } = {}): Promise<Db> {
  // a bigint column (the audit and history ids) comes back as a number, as it does from PGlite; these never get near 2^53
  pg.types.setTypeParser(20, (v) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
  // an idle connection the server drops must not take the whole process down
  pool.on("error", (e) => console.error("Postgres connection error (the pool will replace it):", e.message));
  await pool.query("select 1");
  const on = (q: { query: (...a: any[]) => Promise<any> }): Pick<Db, "query" | "exec"> => ({
    query: async <T,>(sql: string, params?: unknown[]) => ({ rows: (await q.query(sql, params as any[])).rows as T[] }),
    exec: async (sql: string) => { await q.query(sql); },
  });
  const db: Db = {
    ...on(pool),
    tx: async <T,>(fn: (d: Db) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const inner: Db = { ...on(client), tx: (f) => f(inner), close: async () => {} };
        const out = await fn(inner);
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

/** Apply any migration file not yet recorded, in filename order. Safe to run from several servers at once: each migration takes a lock and checks again. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query("create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())");
  const dir = fileURLToPath(new URL("./migrations/", import.meta.url));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.tx(async (t) => {
      await t.query("select pg_advisory_xact_lock(727201)");
      if ((await t.query("select 1 from _migrations where name = $1", [name])).rows.length) return;
      await t.exec(readFileSync(dir + name, "utf8"));
      await t.query("insert into _migrations (name) values ($1)", [name]);
      applied.push(name);
    });
  }
  return applied;
}
