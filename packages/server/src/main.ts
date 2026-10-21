import { buildApp } from "./app.js";
import { migrate, openPglite } from "./db.js";

// Development entry. DATA_DIR keeps the database on disk between runs; without it the database lives in memory.
const db = await openPglite(process.env.DATA_DIR);
const applied = await migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(", ")}`);
const app = buildApp(db);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "127.0.0.1" });
console.log(`Blackline server listening on http://127.0.0.1:${port}`);
