/**
 * Supplier and subcontractor quote register: the evidence behind the rates and packages in the estimate.
 *
 * A quote is evidence, not automatically the controlling tender amount: scope, quantity, exclusions, delivery basis,
 * validity, duplication and specification compliance must reconcile to the estimate before use. Each item records where
 * the evidence lives (`source`, e.g. a Drive file, a Gmail message id or a quote number) so it can be traced.
 */
import { D, type Dec } from "@blackline/engine";

export const FIELDS = [
  "ref", "package", "supplier", "estimate_ref", "qty", "unit", "amount", "scope", "documents", "status", "action", "notes",
  "treatment", "verification", "source", "quote_date", "valid_until",
] as const;
type Field = (typeof FIELDS)[number];

const LIMITS: Record<Field, number> = {
  ref: 20, package: 200, supplier: 200, estimate_ref: 120, qty: 30, unit: 20, amount: 30, scope: 3000, documents: 3000, status: 300,
  action: 3000, notes: 3000, treatment: 3000, verification: 3000, source: 500, quote_date: 20, valid_until: 20,
};

export type Quote = { id: string } & Record<Field, string>;

export class QuoteError extends Error {}

export function setField(item: Quote, field: string, value: unknown): void {
  if (!(FIELDS as readonly string[]).includes(field)) throw new QuoteError(`'${field}' can't be edited on a quote.`);
  const f = field as Field;
  let v = value === null || value === undefined ? "" : String(value).trim();
  if (f === "amount" && v) {
    let x: Dec;
    try {
      x = new D(v.replace(/,/g, "").replace(/^\$+/, ""));
    } catch {
      throw new QuoteError("The amount needs a number.");
    }
    if (!x.isFinite() || x.lt(0)) throw new QuoteError("The amount can't be negative.");
    v = x.toString();
  }
  if (v.length > LIMITS[f]) throw new QuoteError(`${f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} is too long (limit ${LIMITS[f]} characters).`);
  item[f] = v;
}

export function buildItem(itemId: string, v: Partial<Record<Field, unknown>>, existing: Quote[]): Quote {
  const item = { id: itemId, ...Object.fromEntries(FIELDS.map((f) => [f, ""])) } as Quote;
  for (const f of FIELDS) if (v[f] !== undefined && v[f] !== null && v[f] !== "") setField(item, f, v[f]);
  if (!item.package && !item.supplier) throw new QuoteError("Name the package or the supplier.");
  if (!item.ref) {
    const nums = existing.map((x) => /(\d+)\s*$/.exec(x.ref)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
    item.ref = `Q-${String(1 + Math.max(0, ...nums)).padStart(2, "0")}`;
  }
  if (existing.some((x) => x.ref === item.ref)) throw new QuoteError(`${item.ref} is already used.`);
  return item;
}
