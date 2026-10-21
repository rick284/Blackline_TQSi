/** Cost Control on the screen, with no screen in it: the server's raw ledger into what the shared engine takes, and a few display rules. */
import { costControl as K, contract as C } from "@blackline/tender/core";

export type Summary = K.CostSummary;

export interface CostData {
  contract: {
    contractSum: string; tenderAllIn: string; awardedOn: string; revision: { label: string };
    terms: C.Terms; lines: C.BudgetLine[]; budget: { cost: string; margin: string; marginPct: string };
  };
  commitments: (K.Commitment & { voidReason: string | null; createdBy: string; createdAt: string })[];
  actuals: (K.Actual & { voidReason: string | null; createdBy: string; createdAt: string })[];
  variations: (K.Variation & { createdBy: string; decidedBy: string | null; decisionNote: string })[];
  forecasts: { code: string; etc: string | null; note: string; by: string; at: string }[];
  claims: (K.Claim & { submittedOn: string | null; paidOn: string | null; note: string; voidReason: string | null })[];
}

export const ledgerOf = (d: CostData): K.Ledger => ({
  contractSum: d.contract.contractSum, payDays: d.contract.terms.payDays,
  budget: d.contract.lines.map((l) => ({ code: l.code, description: l.description, section: l.section, amount: l.amount, kind: l.kind })),
  commitments: d.commitments, actuals: d.actuals, variations: d.variations, forecasts: d.forecasts, claims: d.claims,
});

/** The summary for a ledger: the same engine, the same answer, as on the server. `today` and the programme's activities are what the warnings are worked out against. */
export const summaryOf = (d: CostData, o: K.CostOptions = {}): Summary => K.costControl(ledgerOf(d), o);

/**
 * The Gantt's tasks as programme activities for the late-activity warning: a task that should have finished by the day before today and is not 100%
 * complete. Summary (heading) tasks and inactive tasks are left out; the date is the calendar date of the scheduled finish.
 */
export function activitiesOf(tasks: { wbs?: string; name: string; finish: string; percent: number; summary: boolean; active: boolean }[]): { activity_code: string; activity_name: string; planned_finish: string; status: string }[] {
  return tasks.filter((t) => !t.summary && t.active).map((t) => ({ activity_code: t.wbs ?? "", activity_name: t.name, planned_finish: t.finish.slice(0, 10), status: t.percent >= 100 ? "Complete" : t.percent > 0 ? "In Progress" : "Not Started" }));
}

/** How a line's standing reads, and whether it needs attention. */
export const STATUS_TEXT: Record<K.LineStatus, string> = { "Over Budget": "Over budget", Watch: "Watch", "Tracking OK": "On track" };

/** The orders on a code that can still be invoiced against (not voided), for the picker on a new cost. */
export function openOrders(d: Pick<CostData, "commitments">, code: string): K.Commitment[] {
  return d.commitments.filter((c) => !c.voided && c.code === code);
}

/** Cost lines on a variation, as typed: a blank row is ignored, so a half-filled form doesn't fail on its empty lines. */
export function variationLines(rows: { code: string; description: string; amount: string }[]) {
  return rows.filter((r) => r.code.trim() || r.amount.trim() || r.description.trim());
}
