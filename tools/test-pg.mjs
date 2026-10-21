// Runs the server's tests through the real `pg` adapter (Postgres's wire protocol, served by PGlite), so the hosted database path is exercised
// without installing Postgres. Two tests that need the database to report an SQL error (not just refuse) skip themselves in this mode.
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["vitest", "run", "packages/server", ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, TEST_DB: "pg" },
});
process.exit(r.status ?? 1);
