/**
 * Contract setup: what happens when a tender is won. The issued revision stays exactly as the client received it; the award copies it into the
 * control budget, which is what Cost Control measures actual cost against.
 *
 *   budget lines   the cost the estimate carried, line by line: each QS item, each pre-margin allowance (CA01-CA16), each subcontract package. They add up to
 *                  the estimate's known cost (`grossKnownPackage`). Each line is rounded to the cent when it is copied, because a stored budget has to be
 *                  exact; the estimate itself still carries full precision.
 *   margin         what the contract sum holds above that cost: overhead, bonds, finance and profit. It is not a budget line, so it can't be spent.
 *   cost codes     for now the estimate's own codes: the QS item code, the allowance reference (CA10), and SUB-01.. for subcontract packages in
 *                  the order they appear. (Whether every job should use one Blackline standard is still an open decision.)
 *   terms          the contract form and the commercial terms a person records when awarding. They are the person's record of the contract, not
 *                  advice on what it should say.
 */
import { cents, D, type Dec, ZERO } from "@blackline/engine";
import type { computeTenderEstimate, TenderInputs } from "./estimate.js";

type Estimate = ReturnType<typeof computeTenderEstimate>;

export class ContractError extends Error {}

export const FORMS = [
  "NZS 3910:2023", "NZS 3910:2013", "NZS 3915:2005", "NZS 3916:2013", "Subcontract agreement", "Purchase order or letter of intent", "Other",
] as const;

export type LineKind = "qs" | "allowance" | "subcontract";
export interface BudgetLine { seq: number; code: string; description: string; section: string; kind: LineKind; source: string; amount: string }
export interface Budget {
  lines: BudgetLine[];
  /** The sum of the lines: the control budget */
  cost: string;
  /** What the tender held above cost, and what it was made of */
  overhead: string;
  bonds: string;
  finance: string;
  profit: string;
  /** The working all-in tender excluding GST, as the revision priced it */
  allIn: string;
  /** The all-in less the budget: overhead, bonds, finance and profit (plus the cent rounding of the lines) */
  margin: string;
}

const money = (x: Dec) => cents(x).toFixed(2);

/** The control budget for an estimate. Pass the inputs it was calculated from (the subcontract packages come from there). */
export function budgetFrom(e: Estimate, inputs: Pick<TenderInputs, "overlays">): Budget {
  const lines: BudgetLine[] = [];
  const add = (code: string, description: string, section: string, kind: LineKind, source: string, amount: Dec) => {
    if (cents(amount).isZero()) return;
    lines.push({ seq: lines.length + 1, code, description, section, kind, source, amount: money(amount) });
  };
  for (const l of e.qs.lines) add(l.code, l.description, l.section, "qs", `qs:${l.code}`, l.amount);
  const named = new Map(e.commercial.map((c) => [c.ref, c.name]));
  for (const [ref, amt] of e.tender.additions) add(ref, named.get(ref) ?? ref, "Allowances", "allowance", `ca:${ref}`, amt);
  inputs.overlays.forEach((o, i) => add(`SUB-${String(i + 1).padStart(2, "0")}`, o.name, "Subcontract packages", "subcontract", `overlay:${o.name}`, new D(String(o.amount || 0))));

  const cost = lines.reduce((t, l) => t.plus(l.amount), ZERO);
  const allIn = cents(e.consolidated.allInTender);
  return {
    lines, cost: money(cost), overhead: money(e.consolidated.overhead), bonds: money(e.consolidated.bonds), finance: money(e.consolidated.retentionFinance),
    profit: money(e.consolidated.profit), allIn: money(allIn), margin: money(allIn.minus(cost)),
  };
}

/** Section subtotals, in the order the sections first appear. */
export function bySection(lines: BudgetLine[]): { section: string; amount: string; lines: number }[] {
  const out = new Map<string, { amount: Dec; lines: number }>();
  for (const l of lines) {
    const s = out.get(l.section) ?? { amount: ZERO, lines: 0 };
    out.set(l.section, { amount: s.amount.plus(l.amount), lines: s.lines + 1 });
  }
  return [...out].map(([section, s]) => ({ section, amount: money(s.amount), lines: s.lines }));
}

// ---- the contract sum and terms ------------------------------------------------------------------------------------------------------------
/** A contract sum typed by a person: dollars and cents, above nothing. */
export function parseSum(v: unknown): string {
  const s = String(v ?? "").trim().replace(/,/g, "").replace(/^\$+/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s) || new D(s).lte(0)) throw new ContractError("The contract sum needs to be a dollar amount above zero, for example 1250000.");
  return new D(s).toFixed(2);
}

export interface Terms {
  form: string;
  contractNumber: string;
  clientRef: string;
  startDate: string;
  completionDate: string;
  claimDay: string;
  payDays: string;
  retentionPct: string;
  retentionNote: string;
  defectsMonths: string;
  ldPerDay: string;
  notes: string;
}

export const BLANK_TERMS: Terms = { form: "", contractNumber: "", clientRef: "", startDate: "", completionDate: "", claimDay: "", payDays: "", retentionPct: "", retentionNote: "", defectsMonths: "", ldPerDay: "", notes: "" };

const TEXT_LIMITS: Partial<Record<keyof Terms, number>> = { contractNumber: 100, clientRef: 100, claimDay: 60, retentionNote: 500, notes: 2000 };
const validDate = (s: string) => s === "" || (/^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s);

/** Apply a change to the terms, checking each field as a person would expect (a real date, a sensible percentage). Unnamed fields are kept. */
export function cleanTerms(change: Partial<Terms>, base: Terms = BLANK_TERMS): Terms {
  const t: Terms = { ...BLANK_TERMS, ...base };
  for (const [k, raw] of Object.entries(change)) {
    const f = k as keyof Terms;
    if (!(f in BLANK_TERMS)) throw new ContractError(`'${k}' isn't part of the contract terms.`);
    const v = String(raw ?? "").trim();
    if (f === "form") {
      if (v !== "" && !(FORMS as readonly string[]).includes(v)) throw new ContractError(`The contract form must be one of: ${FORMS.join("; ")}.`);
    } else if (f === "startDate" || f === "completionDate") {
      if (!validDate(v)) throw new ContractError("That needs to be a real date, for example 2026-11-12.");
    } else if (f === "payDays") {
      if (v !== "" && !(/^\d{1,3}$/.test(v) && Number(v) <= 120)) throw new ContractError("Payment days is a whole number of days, up to 120.");
    } else if (f === "defectsMonths") {
      if (v !== "" && !(/^\d{1,3}$/.test(v) && Number(v) <= 120)) throw new ContractError("The defects period is a whole number of months, up to 120.");
    } else if (f === "retentionPct") {
      if (v !== "" && !(/^\d+(\.\d{1,2})?$/.test(v) && Number(v) <= 20)) throw new ContractError("Retention is a percentage between 0 and 20, for example 5.");
    } else if (f === "ldPerDay") {
      const s = v.replace(/,/g, "").replace(/^\$+/, "");
      if (s !== "" && !/^\d+(\.\d{1,2})?$/.test(s)) throw new ContractError("Liquidated damages per day is a dollar amount, for example 500.");
      t[f] = s;
      continue;
    } else if ((TEXT_LIMITS[f] ?? 0) && v.length > TEXT_LIMITS[f]!) throw new ContractError(`That is too long (limit ${TEXT_LIMITS[f]} characters).`);
    t[f] = v;
  }
  if (t.startDate && t.completionDate && t.completionDate < t.startDate) throw new ContractError("Completion can't be before the start.");
  return t;
}
