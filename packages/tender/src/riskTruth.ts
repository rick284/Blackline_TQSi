/**
 * Risk Truth: the risk-reconciliation layer (Master Prompt Rev5, Triple Verification Rev4, workbook tab "Risk Truth").
 *
 * Risk Truth is a CONTROL layer, not a second direct-cost estimate. Each exposure records where the risk is already
 * priced (baseline), what residual remains, how (if at all) it is modelled, and where it would be integrated. Only an
 * approved, DISTINCT residual provision aimed at CA01 (design / scope residual) or CA02 (construction / execution
 * residual) adds cost to the tender. Likelihood and impact never create dollars.
 *
 * Deliberate platform differences from the workbook (its formulas are weaker than the standards):
 *   1. A populated exposure with NO evidence status is RED, not GREEN.
 *   2. A positive addition whose integration target is not CA01 or CA02 is RED (the workbook would silently drop it).
 *   3. A positive addition not marked "integration complete" holds the platform release gate.
 *   4. Negative provisions are rejected.
 * `gateWorkbook` carries the workbook's exact gate for comparison.
 */
import { D, type Dec, ZERO } from "@blackline/engine";

export const MODES = [
  "Already in Base / No Add", "Unit Rate Delta", "Probability x Impact", "Scenario Weighted", "Fixed Allowance",
  "Specialist Engine", "By Others / Excluded", "RFI Hold",
] as const;
export const OWNERS = ["Primary", "Contributing", "Reference Only"] as const;
export const YESNO = ["Yes", "No", "N/A"] as const;
export const EVIDENCE = ["GREEN", "AMBER", "RED"] as const;
export const FIELDS = [
  "ref", "risk_id", "consequence", "driver", "cost_ref", "treatment", "baseline_amount", "residual", "mode", "qty", "unit",
  "unit_rate", "probability", "provision", "owner", "distinct", "target", "include", "overlap_group", "embedded", "evidence",
  "evidence_note", "integration_complete", "basis", "action", "source",
] as const;
export type Field = (typeof FIELDS)[number];

export const LIMITS: Record<Field, number> = {
  ref: 30, risk_id: 30, consequence: 1500, driver: 120, cost_ref: 200, treatment: 1500, baseline_amount: 30, residual: 1500,
  mode: 40, qty: 30, unit: 20, unit_rate: 30, probability: 10, provision: 30, owner: 20, distinct: 5, target: 120, include: 5,
  overlap_group: 80, embedded: 600, evidence: 5, evidence_note: 600, integration_complete: 5, basis: 3000, action: 3000, source: 800,
};
const NUMERIC: Field[] = ["baseline_amount", "qty", "unit_rate", "provision"];

export type Exposure = { id: string } & Record<Field, string>;

export class RiskTruthError extends Error {}

/** Blank -> null. Anything else must be a finite number. */
export function numOrNull(v: unknown): Dec | null {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  try {
    const x = new D(String(v).replace(/,/g, "").replace(/\$/g, "").trim());
    return x.isFinite() ? x : null;
  } catch {
    return null;
  }
}

const label = (f: string) => {
  const s = f.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function setField(item: Exposure, field: string, value: unknown): void {
  if (!(FIELDS as readonly string[]).includes(field)) throw new RiskTruthError(`'${field}' can't be edited on a risk exposure.`);
  const f = field as Field;
  let v = value === null || value === undefined ? "" : String(value).trim();
  if (NUMERIC.includes(f) && v) {
    const x = numOrNull(v);
    if (x === null) throw new RiskTruthError(`${label(f)} needs a number.`);
    if (x.lt(0)) throw new RiskTruthError(`${label(f)} can't be negative.`);
    v = x.toString();
  }
  if (f === "probability" && v) {
    const x = numOrNull(v);
    if (x === null || x.lt(0) || x.gt(1)) throw new RiskTruthError("Probability must be between 0 and 1 (for example 0.6 for 60%).");
    v = x.toString();
  }
  if (f === "mode" && v && !(MODES as readonly string[]).includes(v)) throw new RiskTruthError(`Calculation mode must be one of: ${MODES.join(", ")}.`);
  if (f === "owner" && v && !(OWNERS as readonly string[]).includes(v)) throw new RiskTruthError("Cost treatment owner must be Primary, Contributing or Reference Only.");
  if ((f === "distinct" || f === "include" || f === "integration_complete") && v && !(YESNO as readonly string[]).includes(v))
    throw new RiskTruthError(`${label(f)} must be Yes, No or N/A.`);
  if (f === "evidence" && v) {
    v = v.toUpperCase();
    if (!(EVIDENCE as readonly string[]).includes(v)) throw new RiskTruthError("Evidence status must be GREEN, AMBER or RED.");
  }
  if (v.length > LIMITS[f]) throw new RiskTruthError(`${label(f)} is too long (limit ${LIMITS[f]} characters).`);
  item[f] = v;
}

export function buildItem(itemId: string, v: Partial<Record<Field, unknown>>, existing: Exposure[]): Exposure {
  const item = { id: itemId, ...Object.fromEntries(FIELDS.map((f) => [f, ""])) } as Exposure;
  item.include = "No";
  for (const f of FIELDS) if (v[f] !== undefined && v[f] !== null && v[f] !== "") setField(item, f, v[f]);
  if (!item.consequence && !item.ref) throw new RiskTruthError("Describe the exposure (what the cost consequence is).");
  if (!item.ref) {
    const base = item.risk_id || "RT";
    const n = 1 + existing.filter((x) => x.risk_id === item.risk_id).length;
    item.ref = `${base}-${String(n).padStart(3, "0")}`;
  }
  if (existing.some((x) => x.ref === item.ref)) throw new RiskTruthError(`${item.ref} is already used.`);
  return item;
}

const norm = (s: string) => s.trim().toLowerCase();

export function modelledResidual(it: Exposure): Dec | null {
  switch (it.mode) {
    case "Already in Base / No Add":
    case "By Others / Excluded":
      return ZERO;
    case "Unit Rate Delta": {
      const q = numOrNull(it.qty), r = numOrNull(it.unit_rate);
      return q === null || r === null ? null : q.times(r);
    }
    case "Probability x Impact": {
      const p = numOrNull(it.probability), r = numOrNull(it.unit_rate);
      return p === null || r === null ? null : p.times(r);
    }
    case "Fixed Allowance":
    case "Specialist Engine":
      return numOrNull(it.provision) ?? ZERO;
    default:
      return null; // RFI Hold, Scenario Weighted, blank mode: no modelled value
  }
}

export const isTarget = (t: string, ca: string) => norm(t) === ca.toLowerCase();

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export interface ExposureResult {
  id: string;
  modelled: Dec | null;
  addition: Dec;
  duplication: string;
  status: "RED" | "AMBER" | "GREEN";
  workbookStatus: "RED" | "AMBER" | "GREEN";
  reasons: string[];
  flows: boolean;
  provisionUnused: boolean;
}

export interface RiskTruthResult {
  exposures: ExposureResult[];
  ca01: Dec;
  ca02: Dec;
  residualTotal: Dec;
  redRisks: number;
  redExposures: number;
  redExposuresWorkbook: number;
  amberExposures: number;
  duplicateGate: "RED" | "OK";
  programmeGate: string;
  gate: string;
  gateWorkbook: string;
  issues: string[];
}

const HOLD = "HOLD - RED ITEMS / INTEGRATION CHECK";

/** items: stored exposures. risks: register items of kind 'risk' (their rag drives the RED risk count). */
export function computeRiskTruth(items: Exposure[], risks: { rag?: string }[] = [], programmeOk: boolean | null = null): RiskTruthResult {
  const costCounts = new Map<string, number>();
  for (const it of items) {
    const k = norm(it.cost_ref);
    if (k) costCounts.set(k, (costCounts.get(k) ?? 0) + 1);
  }
  const out: ExposureResult[] = [];
  const issues: string[] = [];

  for (const it of items) {
    const modelled = modelledResidual(it);
    const prov = numOrNull(it.provision) ?? ZERO;
    const include = it.include === "Yes";
    const addition = include ? prov : ZERO;
    const k = norm(it.cost_ref);

    let dup: string;
    if (include && prov.gt(0) && it.distinct !== "Yes") dup = "RED - RESIDUAL NOT DISTINCT";
    else if (k && (costCounts.get(k) ?? 0) > 1 && !it.overlap_group.trim()) dup = "RED - UNDECLARED OVERLAP";
    else if (k && (costCounts.get(k) ?? 0) > 1) dup = "DECLARED OVERLAP";
    else dup = "OK";

    const ev = it.evidence;
    const reasons: string[] = [];
    let status: ExposureResult["status"];
    const rfiOrNoQty = it.mode === "RFI Hold" || (it.mode === "Unit Rate Delta" && numOrNull(it.qty) === null);
    if (dup.startsWith("RED")) {
      status = "RED";
      reasons.push(titleCase(dup.replace("RED - ", "")));
    } else if (ev === "RED" || rfiOrNoQty) {
      status = "RED";
      reasons.push(ev === "RED" ? "Evidence is RED" : it.mode === "RFI Hold" ? "RFI hold: the residual can't yet be responsibly quantified" : "Unit-rate delta has no quantity");
    } else if (ev === "") {
      status = "RED";
      reasons.push("No evidence status recorded");
    } else if (ev === "AMBER" || it.embedded.trim().toUpperCase().startsWith("CHECK")) {
      status = "AMBER";
      reasons.push(ev === "AMBER" ? "Evidence is AMBER" : "Check whether variability is already embedded");
    } else status = "GREEN";

    // the workbook's own status formula (exact-match evidence, blank evidence passes), for comparison
    let workbookStatus: ExposureResult["workbookStatus"];
    if (dup.startsWith("RED") || ev === "RED" || rfiOrNoQty) workbookStatus = "RED";
    else if (ev === "AMBER" || it.embedded.trim().toUpperCase().startsWith("CHECK")) workbookStatus = "AMBER";
    else workbookStatus = "GREEN";

    const flows = isTarget(it.target, "CA01") || isTarget(it.target, "CA02");
    if (addition.gt(0) && !flows) {
      status = "RED";
      reasons.push("Positive provision has no CA01/CA02 integration target, so it would not reach the tender");
    }
    if (addition.gt(0) && it.integration_complete !== "Yes") issues.push(`${it.ref}: positive provision is not marked integration complete`);

    out.push({ id: it.id, modelled, addition, duplication: dup, status, workbookStatus, reasons, flows, provisionUnused: !include && prov.gt(0) });
  }

  const sumTarget = (ca: string) => items.reduce((t, it, i) => (isTarget(it.target, ca) ? t.plus(out[i]!.addition) : t), ZERO);
  const ca01 = sumTarget("CA01");
  const ca02 = sumTarget("CA02");
  const redRisks = risks.filter((r) => String(r.rag ?? "").toUpperCase() === "RED").length;
  const redExp = out.filter((o) => o.status === "RED").length;
  const redExpWb = out.filter((o) => o.workbookStatus === "RED").length;
  const dupRed = out.some((o) => o.duplication.startsWith("RED"));
  const progRed = programmeOk === false;
  const gateWb = redRisks > 0 || redExpWb > 0 || dupRed || progRed ? HOLD : "PASS";
  const gate = redRisks > 0 || redExp > 0 || dupRed || progRed || issues.length > 0 ? HOLD : "PASS";

  return {
    exposures: out, ca01, ca02, residualTotal: ca01.plus(ca02), redRisks, redExposures: redExp, redExposuresWorkbook: redExpWb,
    amberExposures: out.filter((o) => o.status === "AMBER").length, duplicateGate: dupRed ? "RED" : "OK",
    programmeGate: progRed ? "RED - PROGRAMME COST RECONCILIATION" : "OK", gate, gateWorkbook: gateWb, issues,
  };
}
