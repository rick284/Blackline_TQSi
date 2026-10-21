import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { type Db, migrate, openPg, openPglite } from "./db.js";

/**
 * The server's entry. On a developer's machine it needs nothing (a private database in memory, or on disk with DATA_DIR). Hosted, it is told by
 * environment variables; see docs/HOSTING.md.
 *
 *   NODE_ENV=production    hosted mode: needs DATABASE_URL, listens on all addresses, serves the web app, rate-limits sign-in, signs up only the first company
 *   DATABASE_URL           the Postgres to use (postgres://user:password@host:5432/dbname)
 *                          (add ?sslmode=require to the URL when the host wants an encrypted connection)
 *   PORT, HOST             where to listen (hosted: 3000 on 0.0.0.0)
 *   WEB_DIR                the built web app (default: packages/web/dist next to this package)
 *   REGISTRATION           open | first | closed: who can start a new company (hosted default: first)
 *   TRUST_PROXY=1          the server sits behind the host's proxy: believe the address it forwards
 *   DATA_DIR, SEED_DEMO    development only: keep the PGlite database on disk; load the demo company
 */
const env = process.env;
const production = env.NODE_ENV === "production";
const say = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

if (production && !env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. A hosted Blackline needs a Postgres database; see docs/HOSTING.md.");
  process.exit(1);
}
if (production && (env.SEED_DEMO === "1" || process.argv.includes("--demo"))) {
  console.error("The demo company has a published password, so it is never loaded in production. Unset SEED_DEMO.");
  process.exit(1);
}
const registration = (env.REGISTRATION ?? (production ? "first" : "open")) as "open" | "first" | "closed";
if (!["open", "first", "closed"].includes(registration)) {
  console.error(`REGISTRATION must be open, first or closed (it is "${env.REGISTRATION}").`);
  process.exit(1);
}

let db: Db;
try {
  db = env.DATABASE_URL ? await openPg(env.DATABASE_URL) : await openPglite(env.DATA_DIR);
} catch (e: any) {
  console.error(`Could not open the database: ${e?.message ?? e}`);
  process.exit(1);
}
const applied = await migrate(db);
if (applied.length) say(`Applied migrations: ${applied.join(", ")}`);
// sessions past their 14 days are of no use to anyone
await db.query("delete from sessions where expires_at < now()");

if (env.SEED_DEMO === "1" || process.argv.includes("--demo")) {
  const { seedDemo } = await import("./devSeed.js");
  await seedDemo(db);
}

const defaultWeb = fileURLToPath(new URL("../../web/dist", import.meta.url));
const webDir = env.WEB_DIR ?? (existsSync(defaultWeb) ? defaultWeb : undefined);
if (production && !webDir) say("No built web app found (run `npm run build -w @blackline/web`, or set WEB_DIR): serving the API only.");

const app = buildApp(db, {
  webDir,
  registration,
  rateLimit: production,
  trustProxy: env.TRUST_PROXY === "1",
  secureHeaders: production || !!webDir,
});
const port = Number(env.PORT ?? 3000);
const host = env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
await app.listen({ port, host });
say(`Blackline server listening on http://${host}:${port}${webDir ? ` (web app from ${webDir})` : ""}; registration: ${registration}; database: ${env.DATABASE_URL ? "Postgres" : env.DATA_DIR ? "PGlite on disk" : "PGlite in memory"}`);

// a host stops the server with SIGTERM when it deploys a new version: finish the requests in flight, then close the database
let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    say(`${sig}: shutting down`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    try { await app.close(); await db.close(); } finally { process.exit(0); }
  });
}
