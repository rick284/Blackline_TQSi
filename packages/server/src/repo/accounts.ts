import { hashPassword, hashToken, MIN_PASSWORD, newToken, verifyPassword } from "../auth.js";
import type { Db } from "../db.js";
import { type Ctx, HttpError, type Role, requireRole } from "../errors.js";
import { audit } from "./audit.js";

const SESSION_DAYS = 14;

export interface Session {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  name: string;
  orgName: string;
}

const checkPassword = (pw: string) => {
  if (pw.length < MIN_PASSWORD) throw new HttpError(400, "weak_password", `Use a password of at least ${MIN_PASSWORD} characters.`);
};

async function openSession(db: Db, userId: string, orgId: string): Promise<string> {
  const { token, hash } = newToken();
  await db.query("insert into sessions (token_hash, user_id, org_id, expires_at) values ($1, $2, $3, now() + ($4 || ' days')::interval)", [hash, userId, orgId, String(SESSION_DAYS)]);
  return token;
}

/** A new company and its first user, who owns it. */
export async function registerOrganisation(db: Db, v: { orgName: string; name: string; email: string; password: string }) {
  checkPassword(v.password);
  const passwordHash = await hashPassword(v.password);
  return db.tx(async (t) => {
    if ((await t.query("select 1 from users where lower(email) = lower($1)", [v.email])).rows.length)
      throw new HttpError(409, "email_taken", "That email already has an account. Sign in instead.");
    const org = (await t.query<{ id: string }>("insert into organisations (name) values ($1) returning id", [v.orgName])).rows[0]!;
    const user = (await t.query<{ id: string }>("insert into users (email, name, password_hash) values ($1, $2, $3) returning id", [v.email.trim(), v.name, passwordHash])).rows[0]!;
    await t.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [org.id, user.id]);
    await audit(t, { orgId: org.id, userId: user.id }, "org.created", { detail: { name: v.orgName } });
    return { orgId: org.id, userId: user.id, token: await openSession(t, user.id, org.id) };
  });
}

/** Signs in. A person in several companies names the one they want; with one company it is chosen for them. */
export async function login(db: Db, v: { email: string; password: string; orgId?: string }) {
  const bad = new HttpError(401, "bad_credentials", "That email and password do not match.");
  const user = (await db.query<{ id: string; password_hash: string }>("select id, password_hash from users where lower(email) = lower($1)", [v.email])).rows[0];
  // verify even for an unknown email, so timing does not reveal which emails have accounts
  const ok = await verifyPassword(v.password, user?.password_hash ?? "scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$AAAA");
  if (!user || !ok) throw bad;
  const orgs = (await db.query<{ org_id: string; name: string; role: Role }>(
    "select m.org_id, o.name, m.role from memberships m join organisations o on o.id = m.org_id where m.user_id = $1 order by o.name", [user.id])).rows;
  if (!orgs.length) throw new HttpError(403, "no_organisation", "This account does not belong to a company.");
  const chosen = v.orgId ? orgs.find((o) => o.org_id === v.orgId) : orgs.length === 1 ? orgs[0] : undefined;
  if (v.orgId && !chosen) throw bad;
  if (!chosen) return { choose: orgs.map((o) => ({ orgId: o.org_id, name: o.name })) };
  await audit(db, { orgId: chosen.org_id, userId: user.id }, "login");
  return { orgId: chosen.org_id, userId: user.id, token: await openSession(db, user.id, chosen.org_id) };
}

export async function sessionFor(db: Db, token: string): Promise<Session | null> {
  const row = (await db.query<{ user_id: string; org_id: string; role: Role; email: string; name: string; org_name: string }>(
    `select s.user_id, s.org_id, m.role, u.email, u.name, o.name as org_name
       from sessions s
       join memberships m on m.org_id = s.org_id and m.user_id = s.user_id
       join users u on u.id = s.user_id
       join organisations o on o.id = s.org_id
      where s.token_hash = $1 and s.expires_at > now()`, [hashToken(token)])).rows[0];
  return row ? { userId: row.user_id, orgId: row.org_id, role: row.role, email: row.email, name: row.name, orgName: row.org_name } : null;
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query("delete from sessions where token_hash = $1", [hashToken(token)]);
}

/** Add a person to the caller's company. Managers add estimators and viewers; only an owner adds managers or owners. */
export async function addMember(db: Db, ctx: Ctx, v: { name: string; email: string; password: string; role: Role }) {
  requireRole(ctx, "manager");
  if ((v.role === "manager" || v.role === "owner") && ctx.role !== "owner") throw new HttpError(403, "forbidden", "Only an owner can add a manager or an owner.");
  checkPassword(v.password);
  const passwordHash = await hashPassword(v.password);
  return db.tx(async (t) => {
    let user = (await t.query<{ id: string }>("select id from users where lower(email) = lower($1)", [v.email])).rows[0];
    // an existing account keeps its own password: they are added to this company and sign in as usual
    if (!user) user = (await t.query<{ id: string }>("insert into users (email, name, password_hash) values ($1, $2, $3) returning id", [v.email.trim(), v.name, passwordHash])).rows[0]!;
    const dup = await t.query("select 1 from memberships where org_id = $1 and user_id = $2", [ctx.orgId, user.id]);
    if (dup.rows.length) throw new HttpError(409, "already_member", "That person is already in this company.");
    await t.query("insert into memberships (org_id, user_id, role) values ($1, $2, $3)", [ctx.orgId, user.id, v.role]);
    await audit(t, ctx, "member.added", { detail: { userId: user.id, role: v.role } });
    return { userId: user.id };
  });
}

export async function listMembers(db: Db, ctx: Ctx) {
  return (await db.query<{ user_id: string; name: string; email: string; role: Role }>(
    "select m.user_id, u.name, u.email, m.role from memberships m join users u on u.id = m.user_id where m.org_id = $1 order by u.name", [ctx.orgId])).rows;
}
