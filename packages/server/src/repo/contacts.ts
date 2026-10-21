import type { Db } from "../db.js";
import { type Ctx, HttpError, requireRole } from "../errors.js";
import { audit } from "./audit.js";

export const KINDS = ["client", "consultant", "subcontractor", "supplier", "other"] as const;
export type Kind = (typeof KINDS)[number];

export interface Contact {
  id: string; name: string; kind: Kind; person: string; phone: string; email: string; trade: string; notes: string;
  archived_at: string | null; created_at: string; updated_at: string; jobs: number;
}

const SELECT = `select c.id, c.name, c.kind, c.person, c.phone, c.email, c.trade, c.notes, c.archived_at, c.created_at, c.updated_at,
  (select count(*)::int from jobs j where j.contact_id = c.id and j.org_id = c.org_id) as jobs from contacts c`;

const LIMITS = { name: 200, person: 200, phone: 40, email: 200, trade: 200, notes: 2000 } as const;
type TextField = keyof typeof LIMITS;
const FIELDS = [...(Object.keys(LIMITS) as TextField[]), "kind"] as const;

export type ContactInput = Partial<Record<TextField, string>> & { kind?: string };

/** Trim, check limits and shape; a person's own wording, so nothing is rewritten beyond trimming. */
function clean(v: ContactInput, partial: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    if (v[f] === undefined) continue;
    const s = String(v[f]).trim();
    if (f === "kind") {
      if (!(KINDS as readonly string[]).includes(s)) throw new HttpError(400, "bad_request", `Kind must be one of: ${KINDS.join(", ")}.`);
    } else if (s.length > LIMITS[f]) throw new HttpError(400, "bad_request", `${f} is too long (limit ${LIMITS[f]} characters).`);
    if (f === "name" && !s) throw new HttpError(400, "bad_request", "A contact needs a name.");
    if (f === "email" && s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, "bad_request", "That email address doesn't look right.");
    out[f] = s;
  }
  if (!partial && (!out.name || !out.kind)) throw new HttpError(400, "bad_request", "A contact needs a name and a kind.");
  return out;
}

export async function listContacts(db: Db, ctx: Ctx, o: { archived?: boolean } = {}): Promise<Contact[]> {
  return (await db.query<Contact>(`${SELECT} where c.org_id = $1 ${o.archived ? "" : "and c.archived_at is null"} order by lower(c.name), c.kind`, [ctx.orgId])).rows;
}

async function getContact(db: Db, ctx: Ctx, id: string): Promise<Contact> {
  const c = (await db.query<Contact>(`${SELECT} where c.id = $1 and c.org_id = $2`, [id, ctx.orgId])).rows[0];
  if (!c) throw new HttpError(404, "not_found", "Contact not found.");
  return c;
}

const taken = () => new HttpError(409, "contact_exists", "That company is already in your contacts with that kind.");

export async function createContact(db: Db, ctx: Ctx, v: ContactInput): Promise<Contact> {
  requireRole(ctx, "estimator");
  const c = clean(v, false);
  return db.tx(async (t) => {
    if ((await t.query("select 1 from contacts where org_id = $1 and lower(name) = lower($2) and kind = $3", [ctx.orgId, c.name, c.kind])).rows.length) throw taken();
    const id = (await t.query<{ id: string }>(
      `insert into contacts (org_id, name, kind, person, phone, email, trade, notes, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [ctx.orgId, c.name, c.kind, c.person ?? "", c.phone ?? "", c.email ?? "", c.trade ?? "", c.notes ?? "", ctx.userId])).rows[0]!.id;
    await audit(t, ctx, "contact.created", { detail: { id, name: c.name, kind: c.kind } });
    return getContact(t, ctx, id);
  });
}

/** Latest edit wins; the value it replaced is kept in the contact's history. Nothing changes (and nothing is recorded) when nothing differs. */
export async function updateContact(db: Db, ctx: Ctx, id: string, v: ContactInput): Promise<Contact> {
  requireRole(ctx, "estimator");
  const c = clean(v, true);
  return db.tx(async (t) => {
    const was = (await t.query<any>("select * from contacts where id = $1 and org_id = $2 for update", [id, ctx.orgId])).rows[0];
    if (!was) throw new HttpError(404, "not_found", "Contact not found.");
    const changes: Record<string, { from: string; to: string }> = {};
    for (const [f, to] of Object.entries(c)) if (was[f] !== to) changes[f] = { from: was[f], to };
    if (Object.keys(changes).length === 0) return getContact(t, ctx, id);
    const name = c.name ?? was.name, kind = c.kind ?? was.kind;
    if ((changes.name || changes.kind) && (await t.query("select 1 from contacts where org_id = $1 and lower(name) = lower($2) and kind = $3 and id <> $4", [ctx.orgId, name, kind, id])).rows.length) throw taken();
    const sets = Object.keys(changes).map((f, i) => `${f} = $${i + 3}`).join(", ");
    await t.query(`update contacts set ${sets}, updated_at = now() where id = $1 and org_id = $2`, [id, ctx.orgId, ...Object.values(changes).map((x) => x.to)]);
    await t.query("insert into contact_history (org_id, contact_id, actor, changes) values ($1, $2, $3, $4)", [ctx.orgId, id, ctx.userId, JSON.stringify(changes)]);
    await audit(t, ctx, "contact.updated", { detail: { id, fields: Object.keys(changes) } });
    return getContact(t, ctx, id);
  });
}

/** A contact is archived, never deleted: jobs and quotes that refer to it keep their link. Restoring brings it back. */
export async function setArchived(db: Db, ctx: Ctx, id: string, archived: boolean): Promise<Contact> {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    await getContact(t, ctx, id);
    await t.query(`update contacts set archived_at = ${archived ? "coalesce(archived_at, now())" : "null"}, updated_at = now() where id = $1 and org_id = $2`, [id, ctx.orgId]);
    await audit(t, ctx, archived ? "contact.archived" : "contact.restored", { detail: { id } });
    return getContact(t, ctx, id);
  });
}

export interface HistoryEntry { id: number; at: string; by: string | null; changes: Record<string, { from: string; to: string }> }

export async function contactHistory(db: Db, ctx: Ctx, id: string): Promise<HistoryEntry[]> {
  await getContact(db, ctx, id);
  return (await db.query<HistoryEntry>(
    `select h.id, h.at, u.name as by, h.changes from contact_history h left join users u on u.id = h.actor
      where h.contact_id = $1 and h.org_id = $2 order by h.id desc limit 100`, [id, ctx.orgId])).rows;
}
