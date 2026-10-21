/**
 * Submission: issuing a tender as a frozen revision. These are the rules both the browser and the server use, so they agree on what is
 * ready to go out:
 *
 *   gates            what stops a tender being issued (blockers, which only an owner can override with a written reason) and what is worth a
 *                    look first (warnings). A tender cannot issue while a scope item or quote is still flagged, while a build-up row has no
 *                    rate or a double count, or while the client price schedule does not add up to the all-in tender.
 *   revision labels  Rev A, Rev B ... Rev Z, Rev AA
 *   qualifications   the tender letter's exclusions, assumptions, inclusions and open RFIs, drafted from the register for the estimator to edit
 *   displayOf        an estimate in the shape `diffEstimates` compares, so two revisions (or a revision and the work now) can be set side by side
 */
import { type Dec } from "@blackline/engine";
import type { DisplayEstimate } from "./diff.js";
import type { computeTenderEstimate, TenderInputs } from "./estimate.js";
import type { RecordData, SeedPackage } from "./packaging.js";
import type { RegisterItem } from "./register.js";

type Estimate = ReturnType<typeof computeTenderEstimate>;

export interface Gate {
  id: string;
  /** In plain words, for the person issuing */
  text: string;
  /** The window that fixes it */
  where: "scope" | "estimate" | "commercial" | "summary" | "risk" | "documents" | "procurement";
  count?: number;
}

const BLOCKING_QA = new Set(["RESOURCE CODE", "RATE MISSING", "OPERATOR DOUBLE-COUNT", "FUEL DOUBLE-COUNT"]);
const n = (x: Dec | number | string | null | undefined) => Number(x ?? 0);
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

export function gates(e: Estimate): { blockers: Gate[]; warnings: Gate[] } {
  const blockers: Gate[] = [], warnings: Gate[] = [];
  const sc = e.scope;
  if (sc.counts.total === 0) blockers.push({ id: "scope-none", text: "No scope has been recorded. Every requirement needs an owner and a treatment before the tender goes out.", where: "scope" });
  else {
    if (sc.counts.MISSING) blockers.push({ id: "scope-missing", text: `${plural(sc.counts.MISSING, "scope item")} ${sc.counts.MISSING === 1 ? "has" : "have"} no owner or treatment, or an unresolved item with no RFI.`, where: "scope", count: sc.counts.MISSING });
    if (sc.unhomedQs.length) blockers.push({ id: "scope-unhomed", text: `${plural(sc.unhomedQs.length, "priced QS item")} ${sc.unhomedQs.length === 1 ? "is" : "are"} not covered by any scope requirement (${sc.unhomedQs.slice(0, 6).join(", ")}${sc.unhomedQs.length > 6 ? "…" : ""}).`, where: "scope", count: sc.unhomedQs.length });
    if (sc.counts.CHECK) blockers.push({ id: "scope-check", text: `${plural(sc.counts.CHECK, "scope item")} ${sc.counts.CHECK === 1 ? "is" : "are"} flagged to confirm (a link, a quote or an RFI isn't backed up).`, where: "scope", count: sc.counts.CHECK });
  }
  if (e.documents.open) blockers.push({ id: "documents", text: `${plural(e.documents.open, "document change")} ${e.documents.open === 1 ? "has" : "have"} not been checked against what ${e.documents.open === 1 ? "it touches" : "they touch"} (scope, estimate lines, quotes).`, where: "documents", count: e.documents.open });
  if (e.procurement.blocking) blockers.push({ id: "procurement", text: `${plural(e.procurement.blocking, "thing")} to put right in the selected quotes: ${e.procurement.packages.flatMap((p) => p.problems).slice(0, 2).join(" ")}`, where: "procurement", count: e.procurement.blocking });
  const bad = e.rows.filter((r) => BLOCKING_QA.has(r.qaFlag)).length;
  if (bad) blockers.push({ id: "rows", text: `${plural(bad, "build-up row")} ${bad === 1 ? "has" : "have"} no rate or ${bad === 1 ? "a" : ""} double count.`, where: "estimate", count: bad });
  if (!e.schedule.reconciles) blockers.push({ id: "schedule", text: "The client price schedule does not add up to the all-in tender.", where: "summary" });

  if (e.reconciled === false) warnings.push({ id: "workbook", text: "The figures no longer match the workbook this tender was imported from (expected once you have edited it).", where: "summary" });
  if (!e.riskTruth.gate.startsWith("PASS")) warnings.push({ id: "risk", text: `Risk Truth release gate: ${e.riskTruth.gate}.`, where: "risk" });
  const minor = e.rows.filter((r) => r.qaFlag !== "OK" && !BLOCKING_QA.has(r.qaFlag)).length;
  if (minor) warnings.push({ id: "qa", text: `${plural(minor, "build-up row")} ${minor === 1 ? "has" : "have"} a check flag (not blocking).`, where: "estimate", count: minor });
  if (e.procurement.toAdjudicate) warnings.push({ id: "procurement-open", text: `${plural(e.procurement.toAdjudicate, "package")} ${e.procurement.toAdjudicate === 1 ? "has" : "have"} quotes in and none selected.`, where: "procurement", count: e.procurement.toAdjudicate });
  if (e.procurement.differences) warnings.push({ id: "procurement-diff", text: `${plural(e.procurement.differences, "selected quote")} ${e.procurement.differences === 1 ? "differs" : "differ"} from what the estimate carries for that package.`, where: "procurement", count: e.procurement.differences });
  if (e.programme && "setUp" in e.programme) warnings.push({ id: "programme", text: "No programme has been started, so the weather allowance and time-related costs have no programme behind them.", where: "summary" });
  return { blockers, warnings };
}

// ---- labels -------------------------------------------------------------------------------------------------------------------------------
/** 1 -> "Rev A", 26 -> "Rev Z", 27 -> "Rev AA" */
export function revisionLabel(seq: number): string {
  let s = "";
  for (let k = seq; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
  return `Rev ${s || "A"}`;
}

// ---- the letter, qualifications, alternatives ---------------------------------------------------------------------------------------------
export interface Letter { addressee: string; attention: string; reference: string; subject: string; opening: string; closing: string; signatory: string; validityDays: string }
export interface Qualification { id: string; kind: "exclusion" | "assumption" | "inclusion" | "rfi" | "custom"; ref: string; text: string; include: boolean }
export interface Alternative { id: string; title: string; description: string; amount: string; include: boolean }

export function defaultLetter(job: { name: string; client: string }): Letter {
  return {
    addressee: job.client, attention: "", reference: "", subject: `Tender for ${job.name}`,
    opening: `We are pleased to submit our tender for ${job.name}, priced on the documents listed in the schedule that follows.`,
    closing: "This tender is submitted on the basis of the qualifications, exclusions and assumptions listed. We would be pleased to discuss any part of it.",
    signatory: "", validityDays: "30",
  };
}

/** Qualifications drafted from the register: exclusions and assumptions first, then inclusions and open RFIs. Edited and switched off by the estimator. */
export function qualificationsFrom(register: RegisterItem[]): Qualification[] {
  const order: Record<string, number> = { exclusion: 0, assumption: 1, inclusion: 2, rfi: 3 };
  const out: Qualification[] = [];
  for (const x of register.filter((r) => r.kind in order && !(r.kind === "rfi" && r.status === "CLOSED")).sort((a, b) => (order[a.kind]! - order[b.kind]!))) {
    out.push({ id: `Q${out.length + 1}`, kind: x.kind as Qualification["kind"], ref: x.ref, text: (x.title || x.detail).slice(0, 1000), include: x.kind !== "rfi" });
  }
  return out;
}

/**
 * The Submission package a job starts with: the letter, and the qualifications drafted from the register. Everything in it is edited like any
 * other package, and is part of what a revision freezes. Records: `sub:letter`, `sub:q:<id>` (in order), `sub:alt:<id>`.
 */
export function submissionSeed(job: { name: string; client: string }, register: RegisterItem[]): SeedPackage {
  const records: Record<string, RecordData> = { "sub:letter": { kind: "submissionLetter", body: defaultLetter(job) } };
  qualificationsFrom(register).forEach((q, i) => { records[`sub:q:${q.id}`] = { kind: "submissionQual", seq: (i + 1) * 1000, body: q }; });
  return { key: "submission", name: "Submission", kind: "submission", records };
}

// ---- integrity ------------------------------------------------------------------------------------------------------------------------------
/** The same text for the same records, whatever order they come in and however their keys were written: what a snapshot's hash is taken of. */
export function canonicalRecords(records: { id: string; data: unknown }[]): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
    return v;
  };
  return JSON.stringify([...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((r) => [r.id, sortKeys(r.data)]));
}

// ---- figures ----------------------------------------------------------------------------------------------------------------------------
/** The headline figures kept with a revision (exact decimal text), so the list can show what each one was without recalculating. */
export function headlineTotals(e: Estimate): Record<string, string> {
  return {
    allIn: e.consolidated.allInTender.toString(), ownWorks: e.tender.tenderExclGst.toString(), knownCost: e.consolidated.grossKnownPackage.toString(),
    baseDirect: e.qs.totalDirect.toString(), grossMarginOnSell: e.consolidated.grossMarginOnSell.toString(),
  };
}

/** An estimate in the shape the revision comparison reads. `inputs` gives the task and resource names the engine's row results don't carry. */
export function displayOf(e: Estimate, inputs: TenderInputs): DisplayEstimate {
  const coded = inputs.rows.filter((r) => r.qsCode);
  const additions = e.tender.additions;
  const amountOf = (ref: string): number => (ref === "CA17" ? n(e.tender.overhead) : ref === "CA18" ? n(e.tender.profit) : ref === "CA19" ? n(e.tender.bonds) : ref === "CA20" ? n(e.tender.retentionFinance) : n(additions.get(ref)));
  const line = (ref: string) => e.commercial.find((c) => c.ref === ref);
  const oh = line("CA17"), pr = line("CA18");
  return {
    summary: {
      all_in: n(e.consolidated.allInTender), siteworks_tender: n(e.tender.tenderExclGst), known_cost: n(e.consolidated.grossKnownPackage), base_direct: n(e.qs.totalDirect),
      management_reserve: n(additions.get("CA16")), weather_allowance: n(e.weather.allowance),
    },
    sections: [...e.qs.sectionTotals].map(([section, amount]) => ({ section, amount: n(amount) })),
    qs: e.qs.lines.map((l) => ({ code: l.code, description: l.description, unit: l.unit, quantity: n(l.quantity), amount: n(l.amount) })),
    buildup: e.rows.map((r, i) => ({ row_id: r.rowId, qs_code: r.qsCode, task: String(coded[i]?.task ?? ""), resource: String(coded[i]?.resourceCode ?? ""), applied_rate: n(r.appliedRate), hours: n(r.appliedDurationHrs), cost: n(r.cost) })),
    commercial: e.commercial.map((c) => ({ ref: c.ref, name: c.name, include: c.include === "Yes", method: c.method, pct: n(c.pct), amount: c.include === "Yes" ? amountOf(c.ref) : 0 })),
    consolidated: {
      overlays: inputs.overlays.map((o) => ({ name: o.name, amount: n(o.amount) })),
      overhead_rate: oh && oh.include === "Yes" ? n(oh.pct) : null, margin: pr && pr.include === "Yes" ? n(pr.pct) : null,
    },
  };
}
