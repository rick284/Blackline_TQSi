/**
 * The administrator's tool, run on the server (or anywhere that can reach the database) with DATABASE_URL set. It exists because the app has no
 * password reset by email yet, and because a hosted Blackline signs up only its first company.
 *
 *   npm run admin -w @blackline/server -- list
 *   npm run admin -w @blackline/server -- create-company --org "Acme Civil" --name "Sam Smith" --email sam@acme.co.nz --password "a long password"
 *   npm run admin -w @blackline/server -- reset-password --email sam@acme.co.nz --password "a new long password"
 *
 * Passwords can be given as --password or in the ADMIN_PASSWORD environment variable (which keeps them out of the shell history).
 */
import { MIN_PASSWORD, hashPassword } from "./auth.js";
import { type Db, migrate, openPg, openPglite } from "./db.js";
import { registerOrganisation } from "./repo/accounts.js";

export function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) out[a.slice(2)] = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "";
  }
  return out;
}

const need = (f: Record<string, string>, k: string) => {
  if (!f[k]) throw new Error(`--${k} is needed.`);
  return f[k]!;
};

export async function run(db: Db, command: string, f: Record<string, string>, env: Record<string, string | undefined> = process.env): Promise<string> {
  const password = f.password || env.ADMIN_PASSWORD || "";
  switch (command) {
    case "list": {
      const rows = (await db.query<{ org: string; name: string; email: string; role: string }>(
        `select o.name as org, u.name, u.email, m.role from memberships m join organisations o on o.id = m.org_id join users u on u.id = m.user_id order by o.name, m.role, u.name`)).rows;
      return rows.length ? rows.map((r) => `${r.org}\t${r.role}\t${r.name} <${r.email}>`).join("\n") : "No companies yet.";
    }
    case "create-company": {
      const r = await registerOrganisation(db, { orgName: need(f, "org"), name: need(f, "name"), email: need(f, "email"), password: password || need(f, "password") });
      return `Created ${f.org}; ${f.email} is its owner (company id ${r.orgId}).`;
    }
    case "reset-password": {
      if (password.length < MIN_PASSWORD) throw new Error(`Use a password of at least ${MIN_PASSWORD} characters (--password, or ADMIN_PASSWORD).`);
      const email = need(f, "email");
      const hash = await hashPassword(password);
      return db.tx(async (t) => {
        const u = (await t.query<{ id: string }>("select id from users where lower(email) = lower($1)", [email])).rows[0];
        if (!u) throw new Error(`No account has the email ${email}.`);
        await t.query("update users set password_hash = $1 where id = $2", [hash, u.id]);
        const gone = await t.query("delete from sessions where user_id = $1 returning 1", [u.id]); // anyone signed in with the old password is signed out
        return `Password changed for ${email}; ${gone.rows.length} signed-in session(s) ended.`;
      });
    }
    default:
      throw new Error("Commands: list | create-company --org --name --email [--password] | reset-password --email [--password]");
  }
}

// run as a script (not when imported by a test)
if (process.argv[1] && /admin\.(ts|js)$/.test(process.argv[1])) {
  const [command = "", ...rest] = process.argv.slice(2);
  const db = process.env.DATABASE_URL ? await openPg(process.env.DATABASE_URL, { max: 2 }) : await openPglite(process.env.DATA_DIR);
  try {
    await migrate(db);
    console.log(await run(db, command, flags(rest)));
  } catch (e: any) {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}
