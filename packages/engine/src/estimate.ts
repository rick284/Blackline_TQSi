import { allocate, cents, D, type Dec, sum, ZERO } from "./money.js";
import {
  type Estimate,
  type EstimateLine,
  type ResourceKind,
  RESOURCE_KINDS,
  type Section,
} from "./types.js";

export type ByKind = Record<ResourceKind, Dec>;

export interface LineResult {
  lineId: string;
  /** Direct cost per line unit, 4dp, for display only. Totals never use it. */
  unitRate: Dec;
  byKind: ByKind;
  directCost: Dec;
  labourHours: Dec;
  /** This line's share of the estimate sell price, reconciled to the cent. */
  sell: Dec;
}

export interface SectionResult {
  sectionId: string;
  byKind: ByKind;
  directCost: Dec;
  labourHours: Dec;
  sell: Dec;
}

export interface Summary {
  byKind: ByKind;
  directCost: Dec;
  onCosts: { id: string; name: string; amount: Dec }[];
  overhead: Dec;
  totalCost: Dec;
  margin: Dec;
  sell: Dec;
  labourHours: Dec;
}

export interface EstimateResult {
  lines: Map<string, LineResult>;
  sections: Map<string, SectionResult>;
  summary: Summary;
}

const emptyKinds = (): ByKind =>
  Object.fromEntries(RESOURCE_KINDS.map((k) => [k, ZERO])) as ByKind;

const addKinds = (a: ByKind, b: ByKind): ByKind =>
  Object.fromEntries(RESOURCE_KINDS.map((k) => [k, a[k].plus(b[k])])) as ByKind;

function priceLine(line: EstimateLine, est: Estimate): Omit<LineResult, "sell"> {
  const qty = new D(line.quantity);
  const raw = emptyKinds();
  let hours = ZERO;

  for (const c of line.components) {
    const res = est.resources.find((r) => r.id === c.resourceId);
    if (!res) throw new Error(`Line ${line.code}: unknown resource ${c.resourceId}`);
    const waste = new D(1).plus(new D(c.wastePct ?? 0).div(100));
    const perUnit = new D(c.qtyPerUnit).times(waste);
    raw[res.kind] = raw[res.kind].plus(qty.times(perUnit).times(res.rate));
    if (res.kind === "labour" && res.unit === "hr") hours = hours.plus(qty.times(perUnit));
  }

  // Round each kind to the cent; the line total is the sum of the rounded parts.
  const byKind = Object.fromEntries(RESOURCE_KINDS.map((k) => [k, cents(raw[k])])) as ByKind;
  const directCost = sum(Object.values(byKind));
  const unitRate = qty.isZero() ? ZERO : directCost.div(qty).toDecimalPlaces(4);
  return { lineId: line.id, unitRate, byKind, directCost, labourHours: hours };
}

function collectLines(s: Section, out: EstimateLine[] = []): EstimateLine[] {
  out.push(...s.lines);
  for (const c of s.sections) collectLines(c, out);
  return out;
}

export function calculate(est: Estimate): EstimateResult {
  const lines = collectLines(est.root);
  const priced = lines.map((l) => priceLine(l, est));

  const byKind = priced.reduce((acc, p) => addKinds(acc, p.byKind), emptyKinds());
  const directCost = sum(priced.map((p) => p.directCost));

  const onCosts = est.settings.onCosts.map((oc) => ({
    id: oc.id,
    name: oc.name,
    amount: cents(sum(oc.appliesTo.map((k) => byKind[k])).times(oc.pct).div(100)),
  }));
  const withOnCosts = directCost.plus(sum(onCosts.map((o) => o.amount)));
  const overhead = cents(withOnCosts.times(est.settings.overheadPct).div(100));
  const totalCost = withOnCosts.plus(overhead);

  const mpct = new D(est.settings.margin.pct).div(100);
  const margin =
    est.settings.margin.mode === "markup"
      ? cents(totalCost.times(mpct))
      : cents(totalCost.div(new D(1).minus(mpct)).minus(totalCost));
  const sell = totalCost.plus(margin);

  const labourHours = sum(priced.map((p) => p.labourHours));

  // Spread the sell price over lines in proportion to direct cost.
  const sells = allocate(sell, priced.map((p) => p.directCost));
  const lineMap = new Map<string, LineResult>();
  priced.forEach((p, i) => lineMap.set(p.lineId, { ...p, sell: sells[i]! }));

  const sectionMap = new Map<string, SectionResult>();
  const rollUp = (s: Section): SectionResult => {
    let r: SectionResult = {
      sectionId: s.id,
      byKind: emptyKinds(),
      directCost: ZERO,
      labourHours: ZERO,
      sell: ZERO,
    };
    const add = (x: Omit<SectionResult, "sectionId">) => {
      r = {
        sectionId: s.id,
        byKind: addKinds(r.byKind, x.byKind),
        directCost: r.directCost.plus(x.directCost),
        labourHours: r.labourHours.plus(x.labourHours),
        sell: r.sell.plus(x.sell),
      };
    };
    for (const l of s.lines) add(lineMap.get(l.id)!);
    for (const c of s.sections) add(rollUp(c));
    sectionMap.set(s.id, r);
    return r;
  };
  rollUp(est.root);

  return {
    lines: lineMap,
    sections: sectionMap,
    summary: { byKind, directCost, onCosts, overhead, totalCost, margin, sell, labourHours },
  };
}
