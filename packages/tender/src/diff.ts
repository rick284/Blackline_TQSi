/**
 * Revision comparison: what changed between two computed estimates, and by how much.
 *
 * Pure function over display estimates. Nothing here changes any number; it explains movements so the estimator (and the
 * change-control record) can see exactly why a price moved between revisions.
 */
import { cents, D } from "@blackline/engine";

export const HEADLINE: [string, string][] = [
  ["all_in", "Working all-in tender"],
  ["siteworks_tender", "Own works tender"],
  ["known_cost", "Known cost before OH/profit"],
  ["base_direct", "Base direct estimate"],
  ["management_reserve", "Management Reserve"],
  ["weather_allowance", "Weather allowance"],
];
const EPS = 0.005;

type N = number | null | undefined;

export interface DisplayEstimate {
  summary: Record<string, N>;
  sections: { section: string; amount: number }[];
  qs: { code: string; description: string; unit: string; quantity: number | null; amount: number }[];
  buildup: { row_id: string; qs_code: string; task: string; resource: string; applied_rate: number | null; hours: number | null; cost: number }[];
  commercial: { ref: string; name: string; include: boolean; method: string; pct: number; amount: number }[];
  consolidated: { overlays: { name: string; amount: number }[]; overhead_rate?: number | null; margin?: number | null };
}

/** Difference of the cent-rounded values, so a delta always equals what the user sees (b - a). */
export function delta(a: N, b: N): number {
  return Number(cents(new D(String(b ?? 0))).minus(cents(new D(String(a ?? 0)))).toString());
}

const keysOf = <T>(b: Map<string, T>, a: Map<string, T>) => [...b.keys(), ...[...a.keys()].filter((k) => !b.has(k))];

export function diffEstimates(a: DisplayEstimate, b: DisplayEstimate) {
  const headline = HEADLINE.map(([key, label]) => ({ key, label, a: a.summary[key], b: b.summary[key], delta: delta(a.summary[key], b.summary[key]) }));

  const sa = new Map(a.sections.map((s) => [s.section, s.amount]));
  const sb = new Map(b.sections.map((s) => [s.section, s.amount]));
  const sections = keysOf(sb, sa).map((name) => ({ section: name, a: sa.get(name), b: sb.get(name), delta: delta(sa.get(name), sb.get(name)) }));

  const qa = new Map(a.qs.map((q) => [q.code, q]));
  const qb = new Map(b.qs.map((q) => [q.code, q]));
  const qsChanges = keysOf(qb, qa).flatMap((code) => {
    const x = qa.get(code), y = qb.get(code);
    let kind: "added" | "removed" | "changed";
    if (!x) kind = "added";
    else if (!y) kind = "removed";
    else if (Math.abs(delta(x.amount, y.amount)) > EPS || Math.abs((y.quantity ?? 0) - (x.quantity ?? 0)) > 1e-9) kind = "changed";
    else return [];
    const ref = (y ?? x)!;
    return [{
      code, description: ref.description, unit: ref.unit, kind, qty_a: x?.quantity ?? null, qty_b: y?.quantity ?? null,
      amount_a: x?.amount ?? null, amount_b: y?.amount ?? null, delta: delta(x?.amount ?? 0, y?.amount ?? 0),
    }];
  }).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta));

  const ra = new Map(a.buildup.map((r) => [r.row_id, r]));
  const rb = new Map(b.buildup.map((r) => [r.row_id, r]));
  const rowChanges = keysOf(rb, ra).flatMap((rid) => {
    const x = ra.get(rid), y = rb.get(rid);
    const ref = (y ?? x)!;
    let kind: "added" | "removed" | "changed";
    if (!x) kind = "added";
    else if (!y) kind = "removed";
    else if (Math.abs(delta(x.cost, y.cost)) > EPS || Math.abs((y.applied_rate ?? 0) - (x.applied_rate ?? 0)) > 1e-9 || Math.abs((y.hours ?? 0) - (x.hours ?? 0)) > 1e-9) kind = "changed";
    else return [];
    return [{
      row_id: rid, qs_code: ref.qs_code, task: ref.task, resource: ref.resource, kind, rate_a: x?.applied_rate ?? null, rate_b: y?.applied_rate ?? null,
      hours_a: x?.hours ?? null, hours_b: y?.hours ?? null, cost_a: x?.cost ?? null, cost_b: y?.cost ?? null, delta: delta(x?.cost ?? 0, y?.cost ?? 0),
    }];
  }).sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta));

  const ca = new Map(a.commercial.map((c) => [c.ref, c]));
  const commercial = b.commercial.flatMap((y) => {
    const x = ca.get(y.ref);
    if (!x || x.include !== y.include || x.method !== y.method || Math.abs(delta(x.amount, y.amount)) > EPS || Math.abs(x.pct - y.pct) > 1e-12)
      return [{ ref: y.ref, name: y.name, include_a: x?.include ?? null, include_b: y.include, amount_a: x?.amount ?? null, amount_b: y.amount, delta: delta(x?.amount ?? 0, y.amount) }];
    return [];
  });

  const oa = new Map(a.consolidated.overlays.map((o) => [o.name, o.amount]));
  const ob = new Map(b.consolidated.overlays.map((o) => [o.name, o.amount]));
  const overlays = keysOf(ob, oa)
    .filter((n) => Math.abs(delta(oa.get(n), ob.get(n))) > EPS)
    .map((n) => ({ name: n, a: oa.get(n), b: ob.get(n), delta: delta(oa.get(n), ob.get(n)) }));

  // commercial settings that move the price without touching any cost
  const settings: { key: string; label: string; a: number; b: number }[] = [];
  for (const [key, label] of [["overhead_rate", "Company overhead (markup on cost)"], ["margin", "Profit (true margin on sell)"]] as const) {
    const x = a.consolidated[key], y = b.consolidated[key];
    if (x !== null && x !== undefined && y !== null && y !== undefined && Math.abs(x - y) > 1e-12) settings.push({ key, label, a: x, b: y });
  }

  return {
    settings, headline, sections, qs: qsChanges, buildup: rowChanges, commercial, overlays,
    counts: { qsChanged: qsChanges.length, buildupChanged: rowChanges.length, commercialChanged: commercial.length, overlaysChanged: overlays.length, settingsChanged: settings.length },
    identical: !(qsChanges.length || rowChanges.length || commercial.length || overlays.length || settings.length) && headline.every((h) => Math.abs(h.delta) <= EPS),
  };
}
