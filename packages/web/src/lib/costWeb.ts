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
  contractSum: d.contract.contractSum,
  budget: d.contract.lines.map((l) => ({ code: l.code, description: l.description, section: l.section, amount: l.amount })),
  commitments: d.commitments, actuals: d.actuals, variations: d.variations, forecasts: d.forecasts, claims: d.claims,
});

/** The summary for a ledger: the same engine, the same answer, as on the server. */
export const summaryOf = (d: CostData): Summary => K.costControl(ledgerOf(d));

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
