/**
 * Scope coverage and interface schedule: everything the job needs, each with an owner and an explicit treatment.
 *
 * A detailed workbook is not proof of completeness. Every requirement (permanent works, enabling works, access, temporary
 * works, testing, reinstatement, interfaces with others) must say WHO delivers it and HOW the price treats it, and the
 * platform checks that the treatment is actually backed up. The platform never decides a treatment: it checks it.
 * Status per item: COMPLETE (backed up), CHECK (something to confirm), MISSING (no treatment, or unresolved with no RFI).
 */
import { D, type Dec, ZERO } from "@blackline/engine";
import type { RegisterItem } from "./register.js";

export const GROUPS = [
  "Permanent works", "Enabling works", "Access and site establishment", "Temporary works", "Testing and inspection",
  "Reinstatement and handover", "Preliminaries and management", "Interface with others", "Other",
] as const;
export const OWNERS = ["OWN WORKS", "SUBCONTRACT", "CLIENT", "OTHERS", "SHARED", "TBC"] as const;
export const TREATMENTS = ["PRICED", "ALLOWANCE", "PC SUM", "EXCLUDED", "BY OTHERS", "UNRESOLVED"] as const;
export const FIELDS = ["ref", "group", "title", "detail", "source", "owner", "treatment", "cost_refs", "register_refs", "quote_refs", "basis", "action"] as const;
type Field = (typeof FIELDS)[number];
const LIST_FIELDS: Field[] = ["cost_refs", "register_refs", "quote_refs"];

const LIMITS: Record<Field, number> = {
  ref: 20, group: 60, title: 300, detail: 3000, source: 500, owner: 20, treatment: 20, cost_refs: 300, register_refs: 300, quote_refs: 200, basis: 3000, action: 3000,
};

export type ScopeItem = { id: string } & Record<Field, string>;

export class ScopeError extends Error {}

export const tokens = (text: unknown): string[] => String(text ?? "").trim().split(/[,;\s]+/).filter(Boolean);

export function setField(item: ScopeItem, field: string, value: unknown): void {
  if (!(FIELDS as readonly string[]).includes(field)) throw new ScopeError(`'${field}' can't be edited on a scope item.`);
  const f = field as Field;
  let v = value === null || value === undefined ? "" : String(value).trim();
  if (f === "group") {
    const match = GROUPS.find((g) => g.toLowerCase() === v.toLowerCase());
    if (v && !match) throw new ScopeError(`Group must be one of: ${GROUPS.join(", ")}.`);
    v = match ?? "";
  } else if (f === "owner") {
    v = v.toUpperCase();
    if (v && !(OWNERS as readonly string[]).includes(v)) throw new ScopeError(`Owner must be one of: ${OWNERS.join(", ")}.`);
  } else if (f === "treatment") {
    v = v.toUpperCase();
    if (v && !(TREATMENTS as readonly string[]).includes(v)) throw new ScopeError(`Treatment must be one of: ${TREATMENTS.join(", ")}.`);
  } else if (LIST_FIELDS.includes(f)) v = [...new Set(tokens(v).map((t) => t.toUpperCase()))].join(", ");
  if (v.length > LIMITS[f]) throw new ScopeError(`${f.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} is too long (limit ${LIMITS[f]} characters).`);
  item[f] = v;
}

export function buildItem(itemId: string, v: Partial<Record<Field, unknown>>, existing: ScopeItem[]): ScopeItem {
  const item = { id: itemId, ...Object.fromEntries(FIELDS.map((f) => [f, ""])) } as ScopeItem;
  for (const f of FIELDS) if (v[f] !== undefined && v[f] !== null && v[f] !== "") setField(item, f, v[f]);
  if (!item.title) throw new ScopeError("Describe the requirement (a short title).");
  if (!item.ref) {
    const nums = existing.map((x) => /(\d+)\s*$/.exec(x.ref)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
    item.ref = `SC-${String(1 + Math.max(0, ...nums)).padStart(3, "0")}`;
  }
  if (existing.some((x) => x.ref === item.ref)) throw new ScopeError(`${item.ref} is already used.`);
  return item;
}

const amount = (v: unknown): Dec => {
  try {
    return new D(String(v || 0));
  } catch {
    return ZERO;
  }
};

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export interface ScopeResultItem extends ScopeItem {
  status: "COMPLETE" | "CHECK" | "MISSING";
  problems: string[];
}

/**
 * costs: {QS code or CA line: amount carried}. register: the tender register. quoteRefs: references of the quote register.
 * Returns items with status and problems, counts and the scope gate.
 */
export function computeScope(items: ScopeItem[], costs: Record<string, unknown>, register: RegisterItem[], quoteRefs: Set<string>) {
  const reg = new Map(register.filter((x) => x.ref).map((x) => [x.ref.toUpperCase(), x]));
  const out: ScopeResultItem[] = [];

  for (const it of items) {
    const missing: string[] = [];
    const check: string[] = [];
    const t = it.treatment, owner = it.owner;
    const costRefs = tokens(it.cost_refs), regRefs = tokens(it.register_refs), qRefs = tokens(it.quote_refs);
    const known = costRefs.filter((c) => c in costs);
    for (const c of costRefs) if (!(c in costs)) check.push(`${c} isn't in the estimate.`);
    const carried = known.filter((c) => !amount(costs[c]).isZero());
    for (const c of known) if (!carried.includes(c)) check.push(`${c} carries no cost.`);
    const regs = regRefs.filter((r) => reg.has(r)).map((r) => reg.get(r)!);
    for (const r of regRefs) if (!reg.has(r)) check.push(`${r} isn't in the register.`);
    for (const q of qRefs) if (!quoteRefs.has(q)) check.push(`Quote ${q} isn't in the quote register.`);

    if (!owner) missing.push("No owner: say who delivers it.");
    else if (owner === "TBC") check.push("Owner still to be confirmed.");

    if (!t) missing.push("No treatment: say how the price treats it.");
    else if (t === "PRICED") {
      if (costRefs.length === 0) missing.push("Priced, but no QS item or commercial line is linked.");
    } else if (t === "ALLOWANCE" || t === "PC SUM") {
      if (costRefs.length === 0) missing.push(`${titleCase(t)} with no QS item or commercial line carrying it.`);
      if (!it.basis) check.push("State what the allowance is based on.");
      if (!regs.some((x) => x.kind === "assumption" || x.kind === "rfi")) check.push("Link the assumption or RFI that explains this allowance.");
    } else if (t === "EXCLUDED") {
      if (!regs.some((x) => x.kind === "exclusion")) check.push("Record the exclusion in the register and link it.");
      if (carried.length) check.push("Excluded, but a cost is linked to it.");
    } else if (t === "BY OTHERS") {
      if (owner === "OWN WORKS") check.push("By others, but the owner is own works.");
      if (!regs.some((x) => x.kind === "exclusion" || x.kind === "assumption" || x.kind === "inclusion")) check.push("Record the interface (exclusion or assumption) in the register and link it.");
      if (carried.length) check.push("By others, but a cost is linked to it.");
    } else if (t === "UNRESOLVED") {
      const rfis = regs.filter((x) => x.kind === "rfi");
      if (rfis.length === 0) missing.push("Unresolved with no RFI: raise one.");
      else if (rfis.every((x) => x.status === "CLOSED")) check.push("The RFI is closed: update the treatment.");
      else check.push("Waiting on an open RFI.");
    }
    if (owner === "SUBCONTRACT" && (t === "PRICED" || t === "ALLOWANCE" || t === "PC SUM") && qRefs.length === 0) check.push("Subcontract work with no quote linked.");

    out.push({ ...it, status: missing.length ? "MISSING" : check.length ? "CHECK" : "COMPLETE", problems: [...missing, ...check] });
  }

  const counts = { COMPLETE: 0, CHECK: 0, MISSING: 0 };
  for (const x of out) counts[x.status]++;
  const referenced = new Set(items.flatMap((it) => tokens(it.cost_refs)));
  const unhomed = items.length
    ? Object.entries(costs).filter(([c, a]) => /^[A-Z]{1,4}\d+[A-Z]?$/.test(c) && !c.startsWith("CA") && !amount(a).isZero() && !referenced.has(c)).map(([c]) => c).sort()
    : [];
  const byTreatment = Object.fromEntries(TREATMENTS.map((t) => [t, out.filter((x) => x.treatment === t).length]));

  let gate: string;
  if (items.length === 0) gate = "NOT STARTED - no scope items recorded";
  else if (counts.MISSING || unhomed.length)
    gate = `HOLD - ${counts.MISSING} item(s) without a proper treatment` + (unhomed.length ? `; ${unhomed.length} priced item(s) not in the scope schedule` : "");
  else if (counts.CHECK) gate = `REVIEW - ${counts.CHECK} item(s) to confirm`;
  else gate = "PASS - every requirement has an owner and a backed-up treatment";

  return { items: out, counts: { ...counts, total: out.length }, byTreatment, unhomedQs: unhomed, gate };
}
