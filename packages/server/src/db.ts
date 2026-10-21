/**
 * The database seam. Repositories speak plain Postgres SQL through this tiny interface. Development and tests run it on PGlite
 * (a real Postgres in-process, no install); production will pass the same SQL to a `pg` pool behind the same two methods.
 */
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/** Apply any migration file not yet recorded, in filename order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query("create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())");
  const dir = fileURLToPath(new URL("./migrations/", import.meta.url));
  const done = new Set((await db.query<{ name: string }>("select name from _migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    await db.tx(async (t) => {
      await t.exec(readFileSync(dir + name, "utf8"));
      await t.query("insert into _migrations (name) values ($1)", [name]);
    });
    applied.push(name);
  }
  return applied;
}
