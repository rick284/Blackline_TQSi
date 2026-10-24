import type { Db } from "../db.js";
import { type Ctx, HttpError, requireRole } from "../errors.js";
import { audit } from "./audit.js";

/** The company's resource library: rates kept across jobs. A job copies a rate into its own Rate Library when it uses it. */
export interface CompanyRate {
  id: string; code: string; category: string; description: string; unit: string; baseRate: string;
  operatorIncluded: string; fuelIncluded: string; source: string; updatedAt: string;
}
export type RateInput = Partial<Omit<CompanyRate, "id" | "updatedAt">>;

const SELECT = `select id, code, category, description, unit, base_rate as "baseRate", operator_included as "operatorIncluded", fuel_included as "fuelIncluded", source, updated_at as "updatedAt" from company_rates`;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const LIMITS = { category: 60, description: 300, unit: 20, source: 300 } as const;
const COLS = ["code", "category", "description", "unit", "base_rate", "operator_included", "fuel_included", "source"] as const;

/** Check limits and shape, keyed by column name. A person's own wording, so nothing is rewritten beyond trimming. */
function clean(v: RateInput, partial: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (v.code !== undefined) {
    const c = String(v.code).trim();
    if (!CODE.test(c)) throw new HttpError(400, "bad_request", "A code is letters, numbers, dots and dashes, up to 30 characters, for example LAB-CARP.");
    out.code = c;
  }
  for (const f of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    if (v[f] === undefined) continue;
    const s = String(v[f]).trim();
    if (s.length > LIMITS[f]) throw new HttpError(400, "bad_request", `${f} is too long (limit ${LIMITS[f]} characters).`);
    out[f] = s;
  }
  if (v.baseRate !== undefined) {
    const s = String(v.baseRate).trim() || "0";
    if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new HttpError(400, "bad_request", "A rate needs a number, for example 85.50.");
    out.base_rate = s;
  }
  for (const [f, col] of [["operatorIncluded", "operator_included"], ["fuelIncluded", "fuel_included"]] as const) {
    if (v[f] === undefined) continue;
    const s = String(v[f]).trim();
    if (!["", "Yes", "No"].includes(s)) throw new HttpError(400, "bad_request", `${f} must be Yes, No or blank.`);
    out[col] = s;
  }
  if (!partial && !out.code) throw new HttpError(400, "bad_request", "A rate needs a code.");
  return out;
}

export async function listRates(db: Db, ctx: Ctx): Promise<CompanyRate[]> {
  return (await db.query<CompanyRate>(`${SELECT} where org_id = $1 order by lower(code)`, [ctx.orgId])).rows;
}

async function getRate(db: Db, ctx: Ctx, id: string): Promise<CompanyRate> {
  const r = (await db.query<CompanyRate>(`${SELECT} where id = $1 and org_id = $2`, [id, ctx.orgId])).rows[0];
  if (!r) throw new HttpError(404, "not_found", "Rate not found.");
  return r;
}

const taken = (code: string) => new HttpError(409, "rate_exists", `${code} is already in the company resource library.`);
const insert = (t: Db, ctx: Ctx, c: Record<string, string>) =>
  t.query<{ id: string }>(
    `insert into company_rates (org_id, ${COLS.join(", ")}, created_by) values ($1, ${COLS.map((_, i) => `$${i + 2}`).join(", ")}, $${COLS.length + 2}) returning id`,
    [ctx.orgId, ...COLS.map((k) => c[k] ?? (k === "base_rate" ? "0" : "")), ctx.userId]);

export async function createRate(db: Db, ctx: Ctx, v: RateInput): Promise<CompanyRate> {
  requireRole(ctx, "estimator");
  const c = clean(v, false);
  return db.tx(async (t) => {
    if ((await t.query("select 1 from company_rates where org_id = $1 and lower(code) = lower($2)", [ctx.orgId, c.code])).rows.length) throw taken(c.code!);
    const id = (await insert(t, ctx, c)).rows[0]!.id;
    await audit(t, ctx, "rate.created", { detail: { id, code: c.code } });
    return getRate(t, ctx, id);
  });
}

export async function updateRate(db: Db, ctx: Ctx, id: string, v: RateInput): Promise<CompanyRate> {
  requireRole(ctx, "estimator");
  const c = clean(v, true);
  return db.tx(async (t) => {
    const was = (await t.query<any>("select * from company_rates where id = $1 and org_id = $2 for update", [id, ctx.orgId])).rows[0];
    if (!was) throw new HttpError(404, "not_found", "Rate not found.");
    const changed = Object.entries(c).filter(([k, to]) => was[k] !== to);
    if (changed.length === 0) return getRate(t, ctx, id);
    if (c.code && c.code.toLowerCase() !== String(was.code).toLowerCase() && (await t.query("select 1 from company_rates where org_id = $1 and lower(code) = lower($2) and id <> $3", [ctx.orgId, c.code, id])).rows.length) throw taken(c.code);
    await t.query(`update company_rates set ${changed.map(([k], i) => `${k} = $${i + 3}`).join(", ")}, updated_at = now() where id = $1 and org_id = $2`, [id, ctx.orgId, ...changed.map(([, to]) => to)]);
    await audit(t, ctx, "rate.updated", { detail: { id, fields: changed.map(([k]) => k) } });
    return getRate(t, ctx, id);
  });
}

/** Jobs hold their own copy of a rate, so removing it from the company library never changes a tender. */
export async function deleteRate(db: Db, ctx: Ctx, id: string): Promise<void> {
  requireRole(ctx, "manager");
  await db.tx(async (t) => {
    const r = await getRate(t, ctx, id);
    await t.query("delete from company_rates where id = $1 and org_id = $2", [id, ctx.orgId]);
    await audit(t, ctx, "rate.deleted", { detail: { id, code: r.code } });
  });
}

/** Add several rates at once (a job's own library, say), leaving any code already in the company library as it is. */
export async function addMissing(db: Db, ctx: Ctx, rates: RateInput[]): Promise<{ added: number; skipped: number }> {
  requireRole(ctx, "estimator");
  const cleaned = rates.map((r) => clean(r, false));
  return db.tx(async (t) => {
    let added = 0, skipped = 0;
    for (const c of cleaned) {
      if ((await t.query("select 1 from company_rates where org_id = $1 and lower(code) = lower($2)", [ctx.orgId, c.code])).rows.length) { skipped++; continue; }
      await insert(t, ctx, c);
      added++;
    }
    if (added) await audit(t, ctx, "rate.bulk_added", { detail: { added, skipped } });
    return { added, skipped };
  });
}
