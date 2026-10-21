/**
 * Management Reserve adjudication (policy "Evidence-Weighted Uncertainty, Management Reserve & Labour True-Cost Policy",
 * Rev1, sections 3-5).
 *
 * The reserve is NOT a percentage or a pulled-out sum. It is selected, once per estimate revision, after reviewing the
 * items that cannot realistically be closed out before the price has to go in, each with a probability and an adverse
 * consequence:
 *
 *   weighted exposure = probability x adverse consequence  (consequence = the DELTA against the current priced baseline)
 *
 *  - probability is a range (low / high; one number = low = high) with its own evidence status GREEN / AMBER / UNKNOWN.
 *    UNKNOWN is never turned into a dollar value: the full consequence is kept as a sensitivity.
 *  - an item whose consequence is not quantified gets no dollar value; it is an unquantified tail.
 *  - consequences may be entered as SELL or COST. CA16 is a pre-margin cost, so sell amounts are converted with the
 *    tender's own markup factor (from the commercial engine, not re-derived here).
 *  - overlapping items (same overlap group): only the PRIMARY item is counted. A group with no Primary, or two, is an
 *    issue. An item already provided for in Risk Truth (CA01 / CA02) is not counted again.
 *  - the selected reserve is a FIXED amount for the revision with a recorded rationale; it is compared with the
 *    weighted range (below / within / above) but never computed from it.
 */
import { D, type Dec, ZERO } from "@blackline/engine";
import { numOrNull } from "./riskTruth.js";

export const ITEM_FIELDS = [
  "ref", "title", "source_ref", "exposure_ref", "description", "basis", "impact", "impact_status", "probability_low",
  "probability_high", "prob_status", "prob_basis", "overlap_group", "owner", "action",
] as const;
export const BLOCK_FIELDS = ["selected", "selected_basis", "adjudicated_by", "adjudicated_on"] as const;
type ItemField = (typeof ITEM_FIELDS)[number];
type BlockField = (typeof BLOCK_FIELDS)[number];

const LIMITS: Record<ItemField | BlockField, number> = {
  ref: 30, title: 300, source_ref: 200, exposure_ref: 30, description: 3000, basis: 10, impact: 30, impact_status: 20,
  probability_low: 10, probability_high: 10, prob_status: 10, prob_basis: 3000, overlap_group: 80, owner: 20, action: 3000,
  selected: 30, selected_basis: 3000, adjudicated_by: 120, adjudicated_on: 40,
};
const BASES = ["Sell", "Cost"];
const IMPACT_STATUS = ["Quantified", "Proxy", "Unquantified"];
const PROB_STATUS = ["GREEN", "AMBER", "UNKNOWN"];
const OWNERS = ["Primary", "Contributing", "Reference Only"];

export type ReserveItem = { id: string } & Record<ItemField, string>;
export interface ReserveBlock {
  items: ReserveItem[];
  selected: string;
  selected_basis: string;
  adjudicated_by: string;
  adjudicated_on: string;
}

export class ReserveError extends Error {}

const label = (f: string) => {
  const s = f.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export function newBlock(selected: unknown = "", basis = ""): ReserveBlock {
  return { items: [], selected: selected === null || selected === undefined || selected === "" ? "" : String(selected), selected_basis: basis, adjudicated_by: "", adjudicated_on: "" };
}

export function setBlockField(block: ReserveBlock, field: string, value: unknown): void {
  if (!(BLOCK_FIELDS as readonly string[]).includes(field)) throw new ReserveError(`'${field}' can't be edited on the management reserve.`);
  const f = field as BlockField;
  let v = value === null || value === undefined ? "" : String(value).trim();
  if (f === "selected" && v) {
    const x = numOrNull(v);
    if (x === null || x.lt(0)) throw new ReserveError("The selected reserve needs a number that is not negative.");
    v = x.toString();
  }
  if (v.length > LIMITS[f]) throw new ReserveError(`${label(f)} is too long (limit ${LIMITS[f]} characters).`);
  block[f] = v;
}

export function setItemField(item: ReserveItem, field: string, value: unknown): void {
  if (!(ITEM_FIELDS as readonly string[]).includes(field)) throw new ReserveError(`'${field}' can't be edited on a reserve item.`);
  const f = field as ItemField;
  let v = value === null || value === undefined ? "" : String(value).trim();
  if (f === "impact" && v) {
    const x = numOrNull(v);
    if (x === null || x.lt(0)) throw new ReserveError("The adverse consequence needs a number that is not negative (enter the extra cost against the current price).");
    v = x.toString();
  }
  if ((f === "probability_low" || f === "probability_high") && v) {
    const x = numOrNull(v);
    if (x === null || x.lt(0) || x.gt(1)) throw new ReserveError("A probability must be between 0 and 1 (for example 0.6 for 60%).");
    v = x.toString();
  }
  const checks: [ItemField, string[], string][] = [
    ["basis", BASES, "Basis must be Sell or Cost."],
    ["impact_status", IMPACT_STATUS, "Impact status must be Quantified, Proxy or Unquantified."],
    ["owner", OWNERS, "Owner must be Primary, Contributing or Reference Only."],
  ];
  for (const [fld, allowed, msg] of checks) if (f === fld && v && !allowed.includes(v)) throw new ReserveError(msg);
  if (f === "prob_status" && v) {
    v = v.toUpperCase();
    if (!PROB_STATUS.includes(v)) throw new ReserveError("Probability evidence must be GREEN, AMBER or UNKNOWN.");
  }
  if (v.length > LIMITS[f]) throw new ReserveError(`${label(f)} is too long (limit ${LIMITS[f]} characters).`);
  item[f] = v;
  const lo = numOrNull(item.probability_low), hi = numOrNull(item.probability_high);
  if (lo !== null && hi !== null && hi.lt(lo)) throw new ReserveError("The high probability can't be below the low probability.");
}

export function buildItem(itemId: string, v: Partial<Record<ItemField, unknown>>, existing: ReserveItem[]): ReserveItem {
  const item = { id: itemId, ...Object.fromEntries(ITEM_FIELDS.map((f) => [f, ""])) } as ReserveItem;
  item.basis = "Cost"; item.owner = "Primary"; item.impact_status = "Quantified"; item.prob_status = "AMBER";
  for (const f of ITEM_FIELDS) if (v[f] !== undefined && v[f] !== null && v[f] !== "") setItemField(item, f, v[f]);
  if (item.probability_low && !item.probability_high) item.probability_high = item.probability_low;
  if (!item.title) throw new ReserveError("Name the unresolved item.");
  if (!item.ref) {
    const nums = existing.map((x) => /(\d+)\s*$/.exec(x.ref)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
    item.ref = `MR-${String(1 + Math.max(0, ...nums)).padStart(2, "0")}`;
  }
  if (existing.some((x) => x.ref === item.ref)) throw new ReserveError(`${item.ref} is already used.`);
  return item;
}

export interface ReserveItemResult {
  id: string;
  costImpact: Dec | null;
  weightedLow: Dec | null;
  weightedHigh: Dec | null;
  counted: boolean;
  sensitivity: Dec | null;
  status: "RED" | "AMBER" | "GREEN";
  reasons: string[];
  weightedLowSell: Dec | null;
  weightedHighSell: Dec | null;
}

export interface ReserveResult {
  items: ReserveItemResult[];
  weightedLow: Dec;
  weightedHigh: Dec;
  weightedMid: Dec;
  weightedLowSell: Dec;
  weightedHighSell: Dec;
  weightedMidSell: Dec;
  selected: Dec | null;
  selectedSell: Dec | null;
  selectedPct: Dec | null;
  position: "below" | "within" | "above" | null;
  gap: Dec | null;
  factor: Dec;
  unknownItems: number;
  unquantifiedItems: number;
  issues: string[];
  notes: string[];
  status: "RED" | "AMBER" | "GREEN";
}

/**
 * factor: sell effect of one dollar of pre-margin cost (from the commercial engine). riskExposures: Risk Truth
 * exposures (ref + addition) so an item already provided for in CA01/CA02 is not counted twice. subtotal: the
 * pre-overhead subtotal (the reserve as a percentage, display only).
 */
export function computeReserve(
  block: ReserveBlock,
  factor: Dec,
  riskExposures: { ref: string; addition: Dec }[] = [],
  subtotal: Dec | null = null,
): ReserveResult {
  const f = factor.gt(0) ? factor : new D(1);
  const items = block.items;
  const provided = new Set(riskExposures.filter((x) => x.addition.gt(0)).map((x) => x.ref));
  const groups = new Map<string, ReserveItem[]>();
  for (const it of items) {
    const g = it.overlap_group.trim().toLowerCase();
    if (g) groups.set(g, [...(groups.get(g) ?? []), it]);
  }
  const issues: string[] = [];
  for (const members of groups.values()) {
    const prim = members.filter((m) => m.owner === "Primary");
    if (members.length > 1 && prim.length === 0) issues.push(`Overlap group '${members[0]!.overlap_group}' has no Primary item, so none of it is counted`);
    if (prim.length > 1) issues.push(`Overlap group '${members[0]!.overlap_group}' has ${prim.length} Primary items: only one may carry the cost`);
  }

  const out: ReserveItemResult[] = [];
  let loC = ZERO, hiC = ZERO;
  let unknown = 0, unquantified = 0, amber = 0;
  for (const it of items) {
    const impact = numOrNull(it.impact);
    const costImpact = impact === null || it.impact_status === "Unquantified" ? null : it.basis === "Sell" ? impact.div(f) : impact;
    const plo = numOrNull(it.probability_low);
    let phi = numOrNull(it.probability_high);
    if (plo !== null && phi === null) phi = plo;
    const probKnown = it.prob_status !== "UNKNOWN" && plo !== null;
    const g = it.overlap_group.trim().toLowerCase();
    const reasons: string[] = [];
    let counted = true;
    if (g && it.owner !== "Primary") {
      counted = false;
      reasons.push("Overlaps with another item: only the Primary item is counted");
    }
    if (g && !groups.get(g)!.some((m) => m.owner === "Primary")) counted = false;
    if (it.exposure_ref && provided.has(it.exposure_ref)) {
      counted = false;
      reasons.push(`Already provided for in Risk Truth (${it.exposure_ref})`);
      issues.push(`${it.ref}: already provided for in Risk Truth ${it.exposure_ref}, not counted again`);
    }
    let wLo: Dec | null = null, wHi: Dec | null = null;
    const sensitivity = costImpact;
    if (it.basis === "Sell" && impact !== null && impact.gt(0))
      reasons.push("Entered as a sell figure: it moves whenever overhead or margin change. Prefer the underlying cost");
    if (costImpact === null) {
      reasons.push("Consequence not quantified: an unquantified tail");
      if (counted) unquantified++;
    } else if (costImpact.isZero()) {
      wLo = wHi = ZERO; // no known incremental consequence: nothing to weight, whatever the probability
      reasons.push("No known incremental consequence against the current price");
    } else if (!probKnown) {
      reasons.push("Probability unknown: no dollar value assigned (the full consequence is shown as a sensitivity)");
      if (counted) unknown++;
    } else {
      wLo = plo!.times(costImpact);
      wHi = phi!.times(costImpact);
      if (counted) { loC = loC.plus(wLo); hiC = hiC.plus(wHi); }
    }
    if (counted && it.prob_status === "AMBER") amber++;
    const riskTruthRed = !counted && reasons.some((r) => r.includes("Risk Truth"));
    const status: ReserveItemResult["status"] =
      (it.prob_status === "UNKNOWN" && !(costImpact !== null && costImpact.isZero())) || riskTruthRed ? "RED" : it.prob_status === "AMBER" ? "AMBER" : "GREEN";
    out.push({
      id: it.id, costImpact, weightedLow: wLo, weightedHigh: wHi, counted: counted && wLo !== null,
      sensitivity: !probKnown && costImpact !== null ? sensitivity : null, status, reasons,
      weightedLowSell: wLo === null ? null : wLo.times(f), weightedHighSell: wHi === null ? null : wHi.times(f),
    });
  }

  const selected = numOrNull(block.selected);
  let position: ReserveResult["position"] = null;
  let gap: Dec | null = null;
  const weightedAny = out.some((o) => o.weightedLow !== null && o.counted) && hiC.gt(0);
  if (selected !== null && weightedAny) {
    position = selected.lt(loC) ? "below" : selected.gt(hiC) ? "above" : "within";
    gap = position === "below" ? loC.minus(selected) : position === "above" ? selected.minus(hiC) : ZERO;
  }

  const notes: string[] = [];
  if (selected !== null && !block.selected_basis.trim()) notes.push("No rationale recorded for the selected reserve");
  if (selected === null) notes.push("No reserve selected yet");
  if (selected !== null && out.length === 0) notes.push("No unresolved items recorded: nothing yet supports the selected reserve");
  if (position === "below") notes.push("The selected reserve is below the lowest weighted exposure: record why");
  const sellItems = items.filter((it) => it.basis === "Sell" && (numOrNull(it.impact) ?? ZERO).gt(0)).map((it) => it.ref);
  if (sellItems.length) notes.push(`${sellItems.join(", ")} entered as sell figures: these drift when overhead or margin change (prefer cost)`);
  if (unknown) notes.push(`${unknown} item(s) with unknown probability carry no dollar value`);
  if (unquantified) notes.push(`${unquantified} item(s) have an unquantified consequence (tails for the adjudicator)`);

  let status: ReserveResult["status"] = issues.length ? "RED" : notes.length || amber || position === "below" ? "AMBER" : "GREEN";
  if (selected === null && out.length === 0) status = "AMBER";

  const mid = loC.plus(hiC).div(2);
  return {
    items: out, weightedLow: loC, weightedHigh: hiC, weightedMid: mid, weightedLowSell: loC.times(f), weightedHighSell: hiC.times(f),
    weightedMidSell: mid.times(f), selected, selectedSell: selected === null ? null : selected.times(f),
    selectedPct: selected === null || subtotal === null || subtotal.isZero() ? null : selected.div(subtotal), position, gap,
    factor: f, unknownItems: unknown, unquantifiedItems: unquantified, issues, notes, status,
  };
}
