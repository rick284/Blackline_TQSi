/** Contract Setup, with no screen in it: the budget an award would copy from a revision, and the budget as a spreadsheet file. */
import { assembleInputs, computeTenderEstimate, contract as C } from "@blackline/tender/core";

export type Budget = C.Budget;
export type BudgetLine = C.BudgetLine;
export type Terms = C.Terms;

/** What awarding from this revision would copy into the control budget: the same engine and the same rule the server uses at award. */
export function previewBudget(records: { id: string; data: unknown }[]): Budget {
  const inputs = assembleInputs(records as Parameters<typeof assembleInputs>[0]);
  return C.budgetFrom(computeTenderEstimate(inputs), inputs);
}

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The control budget as CSV (opens in Excel), with the totals under the lines. Amounts stay exact decimal text. */
export function budgetCsv(job: string, lines: BudgetLine[], t: { contractSum: string; cost: string; margin: string }): string {
  const rows: string[][] = [[job, "Control budget"], [], ["Code", "Description", "Section", "Kind", "Budget"], ...lines.map((l) => [l.code, l.description, l.section, l.kind, l.amount]),
    [], ["", "Control budget (cost)", "", "", t.cost], ["", "Margin held in the contract sum", "", "", t.margin], ["", "Contract sum", "", "", t.contractSum]];
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** The date as a calendar date in the person's own time zone, for the award date. */
export const todayYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
