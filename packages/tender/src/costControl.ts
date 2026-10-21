/**
 * Cost control for an awarded job: what has been committed and spent against the control budget, what the work is forecast to finish at, and
 * what that does to the margin. Every total is worked out here (the same code on the laptop and the server) by the QSi commercial-control engine
 * (`projectSummary`) and retention rules (`applyStageRetention`), so the two engines agree on what "committed", "forecast final cost" and
 * "margin at completion" mean. Money here is what was actually ledgered, so it is whole cents throughout (the estimate's full-precision chain
 * ends where the control budget is copied).
 *
 *   commitment   an order placed (a subcontract or purchase order). What still counts as committed is what has not yet been invoiced against it.
 *   actual       cost incurred: an invoice, labour, plant, materials. A credit is a negative amount. It can name the commitment it is against.
 *   variation    a change the client asks for or agrees to: a sell amount, and the cost lines it adds or removes. Only an approved variation moves the
 *                budget and the contract sum; a pending one is shown beside them.
 *   forecast     a person's estimate of the cost still to come on one line. With none, the line is forecast to finish on its revised budget (what is
 *                left after actual and committed), so nothing is assumed to overrun until someone says so.
 *   claim        what has been claimed from the client, the retention held back, and what has been paid.
 *
 * Voided entries stay in the ledger and count for nothing.
 */
import {
  type ActivityIn, applyStageRetention, bySeverity, cents, D, type Dec, generateClaimWarnings, generateProgrammeWarnings, generateVariationWarnings, generateWarnings,
  projectSummary, type ProjectSummary, type Warning, ZERO,
} from "@blackline/engine";

export class CostError extends Error {}

/** New Zealand GST as a fraction. Amounts in the ledger are excluding GST. */
export const NZ_GST = "0.15";

export const ACTUAL_KINDS = ["invoice", "labour", "plant", "materials", "other"] as const;
export type ActualKind = (typeof ACTUAL_KINDS)[number];
export const KIND_LABEL: Record<ActualKind, string> = { invoice: "Invoice", labour: "Labour", plant: "Plant", materials: "Materials", other: "Other" };

export interface BudgetLineIn { code: string; description: string; section: string; amount: string; kind?: string }
export interface Commitment { id: string; code: string; supplier: string; ref: string; description: string; amount: string; date: string; voided: boolean }
export interface Actual { id: string; code: string; kind: ActualKind; supplier: string; ref: string; description: string; amount: string; hours: string; date: string; commitmentId: string | null; voided: boolean }
export interface VariationLine { code: string; description: string; amount: string }
export type VariationStatus = "pending" | "approved" | "rejected";
export interface Variation {
  id: string; ref: string; title: string; status: VariationStatus; sell: string; lines: VariationLine[]; note: string;
  /** When it went to the client, when they should reply by, and whether the work has started without approval: what the variation warnings run on */
  submittedOn?: string | null; responseDue?: string | null; atRisk?: boolean;
}
export interface Forecast { code: string; etc: string | null }
export type ClaimStatus = "draft" | "submitted" | "paid";
export interface Claim { id: string; seq: number; periodEnd: string; valueEx: string; retentionPct: string; status: ClaimStatus; paidAmount: string; voided: boolean; submittedOn?: string | null }

export interface Ledger {
  contractSum: string;
  /** Working days the contract allows for payment after a claim (from the contract terms), so an unpaid claim can be seen to be overdue. Blank: not known. */
  payDays?: string;
  budget: BudgetLineIn[];
  commitments: Commitment[];
  actuals: Actual[];
  variations: Variation[];
  forecasts: Forecast[];
  claims: Claim[];
}

const dec = (s: string | null | undefined) => new D(s && s !== "" ? s : "0");

/** The codes a ledger entry can be booked to: the control budget, and any line an approved variation has added. */
export function codesOf(budget: BudgetLineIn[], variations: Variation[]): { code: string; description: string }[] {
  const out = new Map(budget.map((b) => [b.code, b.description]));
  for (const v of variations) if (v.status === "approved") for (const l of v.lines) if (!out.has(l.code)) out.set(l.code, l.description);
  return [...out].map(([code, description]) => ({ code, description }));
}

export type LineStatus = "Over Budget" | "Watch" | "Tracking OK";
export interface LineResult {
  code: string; description: string; section: string;
  original: Dec; variations: Dec; revised: Dec;
  committed: Dec; actual: Dec;
  /** What is still to come: a person's forecast if there is one, otherwise what is left of the revised budget */
  etc: Dec; etcManual: boolean;
  forecastFinal: Dec;
  /** Revised budget less forecast final cost: negative means the line is forecast to overrun */
  variance: Dec;
  status: LineStatus;
}
export interface CommitmentResult extends Commitment { billed: Dec; remaining: Dec; overBilled: boolean }
export interface ClaimResult extends Claim {
  value: Dec; retention: Dec; netEx: Dec; netInc: Dec; paid: Dec; cumulativeValue: Dec; cumulativeRetention: Dec;
}
export interface CostSummary {
  project: ProjectSummary;
  lines: LineResult[];
  commitments: CommitmentResult[];
  claims: ClaimResult[];
  claimed: { value: Dec; retentionHeld: Dec; netInc: Dec; paid: Dec; outstanding: Dec; pctOfContract: Dec };
  /** Variations asked for and not yet agreed: not in the budget, the contract sum or the forecast margin until approved */
  pending: { count: number; sell: Dec; cost: Dec };
  /** Things to look at, most serious first: QSi's commercial warnings, with a few that are Blackline's own (forecast overrun, over-invoiced order, over-claimed contract) */
  warnings: Warning[];
}

/** A date `n` working days after `ymd`, skipping Saturdays and Sundays. Public holidays are not known to it, so a due date can be a day or two early. */
export function addWorkingDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}

export interface CostOptions {
  /** The calendar day the warnings are worked out for (YYYY-MM-DD). Left out, it is today by the computer's clock; pass it for a repeatable answer. */
  today?: string;
  /** Programme activities (from the Gantt) so a late one can be warned about */
  activities?: ActivityIn[];
}

export function costControl(l: Ledger, o: CostOptions = {}): CostSummary {
  const live = <T extends { voided: boolean }>(xs: T[]) => xs.filter((x) => !x.voided);
  const actuals = live(l.actuals), commitments = live(l.commitments), claims = live(l.claims);
  const approved = l.variations.filter((v) => v.status === "approved");
  const pending = l.variations.filter((v) => v.status === "pending");
  const codes = codesOf(l.budget, l.variations);
  const sectionOf = new Map(l.budget.map((b) => [b.code, b.section]));
  const forecast = new Map(l.forecasts.map((f) => [f.code, f.etc]));

  // what is still committed on each order: its amount less what has been invoiced against it, never below nothing
  const billedOn = (id: string) => actuals.filter((a) => a.commitmentId === id).reduce((t, a) => t.plus(dec(a.amount)), ZERO);
  const commitRes: CommitmentResult[] = commitments.map((c) => {
    const billed = billedOn(c.id);
    const left = dec(c.amount).minus(billed);
    return { ...c, billed: cents(billed), remaining: left.lt(0) ? ZERO : cents(left), overBilled: left.lt(0) };
  });

  const sum = (xs: Dec[]) => xs.reduce((t, x) => t.plus(x), ZERO);
  const engineLines = codes.map(({ code, description }) => {
    const orig = dec(l.budget.find((b) => b.code === code)?.amount);
    const adj = sum(approved.flatMap((v) => v.lines.filter((x) => x.code === code).map((x) => dec(x.amount))));
    const etc = forecast.get(code);
    const b = l.budget.find((x) => x.code === code);
    // QSi treats "Preliminaries" and "Risk" lines specially: Blackline's lines are mapped onto those by where they sit and what they are
    const resource_type = /prelim/i.test(b?.section ?? "") ? "Preliminaries" : b?.kind === "allowance" && /risk|reserve/i.test(description) ? "Risk" : "";
    return {
      id: code, description, resource_type, original_total_cost: orig.toString(), approved_variation_cost_adjustment: adj.toString(),
      actual_cost_to_date: sum(actuals.filter((a) => a.code === code).map((a) => dec(a.amount))).toString(),
      committed_cost: sum(commitRes.filter((c) => c.code === code).map((c) => c.remaining)).toString(),
      forecast_cost_to_complete: etc === null || etc === undefined ? null : etc,
    };
  });

  const approvedSell = sum(approved.map((v) => dec(v.sell)));
  const pendingSell = sum(pending.map((v) => dec(v.sell)));
  const budgetCost = sum(l.budget.map((b) => dec(b.amount)));
  const project = projectSummary(
    engineLines, actuals.map((a) => ({ amount_ex_gst: a.amount, labour_hours: a.hours || 0, commercial_budget_line_id: a.code })),
    commitments.map((c) => ({ committed_amount_ex_gst: c.amount, commercial_budget_line_id: c.code })),
    // pending variations are kept out of the forecast: the engine would add their sell price without their cost and overstate the margin
    { original_contract_value_ex_gst: l.contractSum, original_budget_cost: budgetCost.toString() }, approvedSell.toString(), 0, 0,
  );
  const pendingCost = sum(pending.flatMap((v) => v.lines.map((x) => dec(x.amount))));

  const lines: LineResult[] = project.lines.map((pl) => {
    const code = String(pl.id);
    const s = pl.summary;
    const adj = dec(String(pl.approved_variation_cost_adjustment));
    return {
      code, description: String(pl.description), section: sectionOf.get(code) ?? "Variations",
      original: cents(dec(String(pl.original_total_cost))), variations: cents(adj), revised: s.revisedBudgetCost,
      committed: cents(dec(String(pl.committed_cost))), actual: cents(dec(String(pl.actual_cost_to_date))),
      etc: s.forecastCostToComplete, etcManual: forecast.get(code) !== undefined && forecast.get(code) !== null,
      forecastFinal: s.forecastFinalCost, variance: s.costVarianceToRevised, status: s.status,
    };
  });

  // claims, in order: retention is the percentage the claim was made at, taken off the value of the claim
  let cumV = ZERO, cumR = ZERO;
  const claimRes: ClaimResult[] = [...claims].sort((a, b) => a.seq - b.seq).map((c) => {
    const value = cents(dec(c.valueEx));
    const pct = dec(c.retentionPct);
    const r = applyStageRetention(value, { enabled: pct.gt(0), pct: pct.toString() }, new D(NZ_GST));
    cumV = cumV.plus(value); cumR = cumR.plus(r.retentionExGst);
    return { ...c, value, retention: r.retentionExGst, netEx: r.netExGst, netInc: r.netIncGst, paid: cents(dec(c.paidAmount)), cumulativeValue: cumV, cumulativeRetention: cumR };
  });
  const billed = claimRes.filter((c) => c.status !== "draft");
  // a draft hasn't gone to the client yet, so only submitted and paid claims count as claimed
  const netInc = sum(billed.map((c) => c.netInc)), paid = sum(claimRes.map((c) => c.paid));
  const claimedValue = sum(billed.map((c) => c.value));
  const claimed = {
    value: cents(claimedValue), retentionHeld: cents(sum(billed.map((c) => c.retention))), netInc: cents(netInc), paid: cents(paid), outstanding: cents(netInc.minus(paid)),
    pctOfContract: project.currentContractValue.gt(0) ? cents(claimedValue.div(project.currentContractValue).times(100)) : ZERO,
  };

  // ---- warnings
  const today = o.today ?? new Date().toISOString().slice(0, 10);
  const found: Warning[] = generateWarnings(project, { label: (x) => `${String(x.id)} ${String(x.description)}`, resourceType: (x) => String(x.resource_type ?? "") });
  const overrun = new Set(found.filter((w) => w.warning_type === "Cost Overrun").map((w) => w.commercial_budget_line_id));

  // Blackline's own: a line forecast to overrun before the money has been spent, an order invoiced beyond itself, a contract claimed beyond its sum
  for (const x of lines) {
    if (overrun.has(x.code) || (x.status !== "Over Budget" && x.status !== "Watch")) continue;
    found.push({
      warning_type: "Forecast Overrun", severity: x.status === "Over Budget" ? "High" : "Medium", title: `Forecast overrun: ${x.code} ${x.description}`,
      description: `Forecast to finish ${money(x.variance.neg())} over its budget${x.status === "Watch" ? " (less than 5%)" : ""}.`,
      suggested_action: "Review the forecast, seek variation recovery or find the saving.", commercial_budget_line_id: x.code,
    });
  }
  for (const c of commitRes) {
    if (c.overBilled) found.push({
      warning_type: "Order Over-invoiced", severity: "Medium", title: `${[c.supplier, c.ref || c.description].filter(Boolean).join(" ")}: invoiced beyond the order`,
      description: `Invoiced ${money(c.billed.minus(dec(c.amount)))} more than the order of ${money(dec(c.amount))}.`, suggested_action: "Check the invoices against the order, or raise a variation to the order.",
    });
  }
  if (claimed.pctOfContract.gt(100)) found.push({ warning_type: "Claimed Over Contract", severity: "High", title: "More than the whole contract has been claimed", description: `${claimed.pctOfContract.toString()}% of the contract sum has been claimed.`, suggested_action: "Check the claims against the contract sum and the approved variations." });

  // QSi's variation warnings, from a variation's own dates and flags (the wording says V01, as the person does)
  const vnum = (ref: string) => Number(/(\d+)\s*$/.exec(ref)?.[1] ?? 0);
  const refOf = new Map(l.variations.map((v) => [v.id, v.ref]));
  found.push(...generateVariationWarnings(l.variations.map((v) => ({
    id: v.id, variation_number: vnum(v.ref), title: v.title,
    status: v.status === "approved" ? "Approved" : v.status === "rejected" ? "Rejected" : v.atRisk ? "Proceeding At Risk" : v.submittedOn ? "Submitted" : "Draft",
    response_due_date: v.responseDue ?? "", total_sell_ex_gst: v.sell, approved_sell_ex_gst: v.sell,
  })), {}, today).map((w) => ({ ...w, title: w.title.replace(/^VO-\d+/, refOf.get(w.variation_id ?? "") ?? "Variation") })));

  // QSi's claim warnings: payment is due the contract's number of working days after the claim went in
  const payDays = Number(l.payDays ?? "");
  found.push(...generateClaimWarnings(claimRes.map((c) => ({
    claim_number: c.seq, status: c.status === "draft" ? "Draft" : c.status === "submitted" ? "Issued" : c.paid.lt(c.netInc) ? "Part Paid" : "Paid",
    payment_due_date: c.status === "submitted" && c.submittedOn && Number.isFinite(payDays) && payDays > 0 ? addWorkingDays(c.submittedOn, payDays) : "",
    current_claim_ex_gst: c.value.toString(), amount_due_inc_gst: c.netInc.toString(), paid_amount_inc_gst: c.paid.toString(),
  })), [], {}, today).map((w) => ({ ...w, title: w.title.replace(/^CLAIM-0*(\d+)/, "Claim $1") })));

  found.push(...generateProgrammeWarnings(o.activities ?? [], [], [], today));

  return {
    project, lines, commitments: commitRes, claims: claimRes, claimed, pending: { count: pending.length, sell: cents(pendingSell), cost: cents(pendingCost) },
    warnings: bySeverity(found),
  };
}

const money = (x: Dec) => cents(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",").replace(/^/, "$");

// ---- checking what a person types ----------------------------------------------------------------------------------------------------------
export function parseMoney(v: unknown, o: { allowNegative?: boolean; what?: string } = {}): string {
  const s = String(v ?? "").trim().replace(/,/g, "").replace(/^(-?)\$+/, "$1");
  const what = o.what ?? "The amount";
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new CostError(`${what} needs to be dollars and cents, for example 2500.50.`);
  const x = new D(s);
  if (x.lt(0) && !o.allowNegative) throw new CostError(`${what} can't be negative.`);
  return x.toFixed(2);
}

export function parseDate(v: unknown, what = "The date"): string {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw new CostError(`${what} needs to be a real date, for example 2026-11-12.`);
  return s;
}

const text = (v: unknown, max: number, what: string, required = false) => {
  const s = String(v ?? "").trim();
  if (required && !s) throw new CostError(`${what} is needed.`);
  if (s.length > max) throw new CostError(`${what} is too long (limit ${max} characters).`);
  return s;
};

export function cleanCommitment(v: Record<string, unknown>, codes: Set<string>) {
  const code = text(v.code, 40, "The budget line", true);
  if (!codes.has(code)) throw new CostError(`${code} isn't a line in the control budget.`);
  const amount = parseMoney(v.amount, { what: "The order amount" });
  if (new D(amount).isZero()) throw new CostError("The order amount can't be nothing.");
  return { code, supplier: text(v.supplier, 200, "The supplier", true), ref: text(v.ref, 60, "The order number"), description: text(v.description, 500, "The description"), amount, date: parseDate(v.date, "The order date") };
}

export function cleanActual(v: Record<string, unknown>, codes: Set<string>) {
  const code = text(v.code, 40, "The budget line", true);
  if (!codes.has(code)) throw new CostError(`${code} isn't a line in the control budget.`);
  const kind = String(v.kind ?? "invoice");
  if (!(ACTUAL_KINDS as readonly string[]).includes(kind)) throw new CostError(`The kind must be one of: ${ACTUAL_KINDS.join(", ")}.`);
  const amount = parseMoney(v.amount, { allowNegative: true, what: "The cost" });
  if (new D(amount).isZero()) throw new CostError("The cost can't be nothing.");
  const hoursRaw = String(v.hours ?? "").trim();
  if (hoursRaw && !/^\d+(\.\d{1,2})?$/.test(hoursRaw)) throw new CostError("Hours is a number, for example 7.5.");
  return {
    code, kind: kind as ActualKind, supplier: text(v.supplier, 200, "The supplier or person"), ref: text(v.ref, 60, "The invoice or reference number"),
    description: text(v.description, 500, "The description"), amount, hours: hoursRaw, date: parseDate(v.date, "The date"),
  };
}

export function cleanVariation(v: Record<string, unknown>, codes: Set<string>) {
  const title = text(v.title, 300, "The title", true);
  const sell = parseMoney(v.sell, { allowNegative: true, what: "The sell amount" });
  const rawLines = Array.isArray(v.lines) ? v.lines : [];
  if (rawLines.length > 100) throw new CostError("That is a lot of cost lines for one variation: group some of them.");
  const seen = new Set<string>();
  const lines: VariationLine[] = rawLines.map((r: any) => {
    const code = text(r?.code, 40, "A cost line's budget code", true);
    if (seen.has(code)) throw new CostError(`${code} is on this variation twice.`);
    seen.add(code);
    return { code, description: text(r?.description, 300, `The description for ${code}`, !codes.has(code)), amount: parseMoney(r?.amount, { allowNegative: true, what: `The cost for ${code}` }) };
  });
  const optionalDate = (x: unknown, what: string) => (x === null || x === undefined || String(x).trim() === "" ? null : parseDate(x, what));
  const submittedOn = optionalDate(v.submittedOn, "The date it was sent to the client");
  const responseDue = optionalDate(v.responseDue, "The date the client should reply by");
  if (submittedOn && responseDue && responseDue < submittedOn) throw new CostError("The client's reply can't be due before the variation was sent.");
  const atRisk = v.atRisk === true || v.atRisk === "true";
  return { ref: text(v.ref, 40, "The variation number"), title, sell, lines, note: text(v.note, 2000, "The note"), submittedOn, responseDue, atRisk };
}

export function cleanForecast(v: Record<string, unknown>, codes: Set<string>) {
  const code = text(v.code, 40, "The budget line", true);
  if (!codes.has(code)) throw new CostError(`${code} isn't a line in the control budget.`);
  const raw = v.etc === null || v.etc === undefined || String(v.etc).trim() === "" ? null : parseMoney(v.etc, { what: "The cost still to come" });
  return { code, etc: raw, note: text(v.note, 500, "The note") };
}

export function cleanClaim(v: Record<string, unknown>) {
  const value = parseMoney(v.valueEx, { allowNegative: false, what: "The claim value" });
  if (new D(value).isZero()) throw new CostError("The claim value can't be nothing.");
  return { periodEnd: parseDate(v.periodEnd, "The claim date"), valueEx: value, note: text(v.note, 1000, "The note") };
}
