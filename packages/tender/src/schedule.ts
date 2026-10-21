/**
 * Client price schedule: the tender priced in the client's own format (e.g. a main contractor's trade-line schedule).
 *
 * Every dollar of the known package is a SOURCE: a QS item (own works), a pre-margin allowance line CA01-CA16 (own works),
 * or a subcontract overlay. Each source is mapped to schedule lines, so nothing can be counted twice or left out.
 *
 *   line kinds   work    priced from mapped sources, included in the group sub-total
 *                pg      preliminaries / common costs, priced from mapped sources, shown after the sub-total
 *                margin  computed: the group's sell price minus its other lines (carries overhead, profit and hidden allocations)
 *   source keys  "qs:<code>"  "ca:<ref>"  "overlay:<name>"
 *   target       "line:<ref>"   put it on that line
 *                "group:<id>"   hold it inside that group's Margin line (a cost the client's schedule has no line for)
 *                "spread"       share it across the groups in proportion to their own-works lines, inside the Margin lines
 *                or a list of parts [{to, amount}, ...]; at most one part may omit the amount (takes the rest)
 *
 * Group sell price = a x group cost + b x (group cost / package cost), where (a, b) is the commercial stack as a straight line
 * (`packageSellLine`): the same true-margin pricing as the consolidated package, so the groups add up to the all-in tender
 * exactly; `difference` reports anything that does not.
 */
import { cents, D, type Dec, ZERO } from "@blackline/engine";
import { d, type Num } from "./models.js";

export const KINDS = ["work", "pg", "margin"] as const;
export type LineKind = (typeof KINDS)[number];

export class ScheduleError extends Error {}

export interface ScheduleLine { ref: string; trade: string; kind: LineKind | string }
export interface ScheduleGroup { id: string; name: string; code?: string; lines: ScheduleLine[] }
export type Target = string | { to: string; amount?: Num }[];
export interface Schedule {
  name?: string;
  client?: string;
  auto?: boolean;
  groups: ScheduleGroup[];
  map?: Record<string, Target>;
}

export interface ScheduleSource { key: string; label: string; amount: Num; own: boolean }

const ONE = new D(1);
const HALF_CENT = new D("0.005");
const money = (x: Dec) => cents(x).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function validateSchedule(s: Schedule): void {
  if (!s || !Array.isArray(s.groups) || s.groups.length === 0) throw new ScheduleError("A price schedule needs at least one group of lines.");
  const refs = new Set<string>(), ids = new Set<string>();
  for (const g of s.groups) {
    const gid = String(g.id ?? "");
    if (!gid || ids.has(gid)) throw new ScheduleError("Each schedule group needs its own identity.");
    ids.add(gid);
    const margins = (g.lines ?? []).filter((ln) => ln.kind === "margin");
    if (margins.length !== 1) throw new ScheduleError(`Group '${g.name ?? gid}' needs exactly one Margin line (it carries overhead and profit).`);
    for (const ln of g.lines) {
      if (!(KINDS as readonly string[]).includes(ln.kind)) throw new ScheduleError(`Line '${ln.ref}' has an unknown kind.`);
      if (!String(ln.ref ?? "").trim() || refs.has(ln.ref)) throw new ScheduleError(`Line reference '${ln.ref}' is blank or used twice.`);
      refs.add(ln.ref);
    }
  }
  if (s.map !== undefined && (typeof s.map !== "object" || s.map === null || Array.isArray(s.map))) throw new ScheduleError("The schedule mapping must be a dictionary.");
}

/** Used when a tender has no client format: one line per QS section, one per subcontract package, one for allowances. */
export function defaultSchedule(sections: string[], overlayNames: string[]): Schedule {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lines: ScheduleLine[] = sections.map((sec, i) => ({ ref: pad(i + 1), trade: sec, kind: "work" }));
  let n = lines.length;
  overlayNames.forEach((name, i) => lines.push({ ref: pad(n + i + 1), trade: name, kind: "work" }));
  n = lines.length;
  lines.push({ ref: pad(n + 1), trade: "Allowances and provisions (weather, risk, reserve)", kind: "pg" });
  lines.push({ ref: pad(n + 2), trade: "Overhead and margin", kind: "margin" });
  return { name: "Price schedule", client: "", auto: true, groups: [{ id: "works", name: "WORKS", code: "", lines }], map: {} };
}

/** Mapping for defaultSchedule(): QS items by section, overlays one each, allowances on the allowance line. */
export function autoMap(schedule: Schedule, qs: { code: string; section: string }[], overlays: { name: string }[], sourcesCa: string[]): Record<string, Target> {
  const lines = schedule.groups[0]!.lines;
  const secLine = new Map(lines.filter((ln) => ln.kind === "work").map((ln) => [ln.trade, ln.ref]));
  const pg = lines.find((ln) => ln.kind === "pg")!.ref;
  const mp: Record<string, Target> = {};
  for (const q of qs) mp[`qs:${q.code}`] = `line:${secLine.get(q.section)}`;
  for (const o of overlays) mp[`overlay:${o.name}`] = `line:${secLine.get(o.name)}`;
  for (const ref of sourcesCa) mp[`ca:${ref}`] = `line:${pg}`;
  return mp;
}

function parts(value: Target, amount: Dec, key: string): [string, Dec][] {
  if (typeof value === "string") return [[value, amount]];
  if (!Array.isArray(value) || value.length === 0) throw new ScheduleError(`${key}: the mapping isn't valid.`);
  const blank = (p: { amount?: Num }) => p.amount === null || p.amount === undefined || p.amount === "";
  const fixed: [string, Dec][] = value.filter((p) => !blank(p)).map((p) => [p.to, d(p.amount)]);
  const rest = value.filter(blank).map((p) => p.to);
  if (rest.length > 1) throw new ScheduleError(`${key}: only one part of a split can take the remainder.`);
  const used = fixed.reduce((t, [, a]) => t.plus(a), ZERO);
  if (fixed.some(([, a]) => a.lt(0))) throw new ScheduleError(`${key}: a split amount can't be negative.`);
  if (used.gt(amount.plus(HALF_CENT))) throw new ScheduleError(`${key}: the split amounts add up to more than the item's value.`);
  const out = [...fixed];
  if (rest.length) out.push([rest[0]!, amount.minus(used)]);
  else if (amount.minus(used).gt(HALF_CENT)) out.push(["", amount.minus(used)]); // unallocated remainder
  return out;
}

export interface PricedLine { ref: string; trade: string; kind: string; amount: Dec; sources: { key: string; label: string; amount: Dec }[]; hidden?: Dec }
export interface PricedGroup { id: string; name: string; code: string; lines: PricedLine[]; subtotal: Dec; cost: Dec; hidden: Dec; total: Dec }
export interface ScheduleResult {
  name: string;
  client: string;
  groups: PricedGroup[];
  total: Dec;
  allIn: Dec;
  difference: Dec;
  unmapped: { key: string; label: string; amount: Dec }[];
  problems: string[];
  reconciles: boolean;
  grossPackage: Dec;
  mapped: Dec;
}

/**
 * line = {a, b} from `packageSellLine`, so fixed overhead / profit / bond amounts are shared by cost and the groups add up to
 * the package. The rate form (overheadRate, margin) is the older markup-overhead, true-margin pricing.
 */
export function computeSchedule(
  schedule: Schedule,
  sources: ScheduleSource[],
  allInIn: Dec,
  pricing: { line: { a: Dec; b: Dec } } | { overheadRate: Num; margin: Num },
): ScheduleResult {
  validateSchedule(schedule);
  const allIn = d(allInIn);
  const groups = new Map(schedule.groups.map((g) => [g.id, g]));
  const lineGroup = new Map(schedule.groups.flatMap((g) => g.lines.map((ln) => [ln.ref, g.id] as const)));
  const amt = new Map<string, Dec>(schedule.groups.flatMap((g) => g.lines.filter((ln) => ln.kind !== "margin").map((ln) => [ln.ref, ZERO] as const)));
  const srcOnLine = new Map<string, { key: string; label: string; amount: Dec }[]>([...amt.keys()].map((r) => [r, []]));
  const ownWeight = new Map<string, Dec>([...groups.keys()].map((g) => [g, ZERO]));
  const hidden = new Map<string, Dec>([...groups.keys()].map((g) => [g, ZERO]));
  let spreadTotal = ZERO;
  const unmapped: ScheduleResult["unmapped"] = [];
  const problems: string[] = [];
  const mp = schedule.map ?? {};
  const bump = (m: Map<string, Dec>, k: string, v: Dec) => m.set(k, (m.get(k) ?? ZERO).plus(v));

  for (const s of sources) {
    const amount = d(s.amount);
    if (amount.isZero()) continue;
    if (!(s.key in mp)) { unmapped.push({ key: s.key, label: s.label, amount }); continue; }
    let ps: [string, Dec][];
    try {
      ps = parts(mp[s.key]!, amount, s.key);
    } catch (e) {
      if (!(e instanceof ScheduleError)) throw e;
      problems.push(e.message);
      unmapped.push({ key: s.key, label: s.label, amount });
      continue;
    }
    for (const [target, a] of ps) {
      if (a.isZero()) continue;
      if (target.startsWith("line:") && amt.has(target.slice(5))) {
        const ref = target.slice(5);
        bump(amt, ref, a);
        srcOnLine.get(ref)!.push({ key: s.key, label: s.label, amount: a });
        if (s.own) bump(ownWeight, lineGroup.get(ref)!, a);
      } else if (target.startsWith("group:") && groups.has(target.slice(6))) bump(hidden, target.slice(6), a);
      else if (target === "spread") spreadTotal = spreadTotal.plus(a);
      else {
        problems.push(`${s.key}: target '${target}' doesn't exist in this schedule.`);
        unmapped.push({ key: s.key, label: s.label, amount: a });
      }
    }
  }

  const weightSum = [...ownWeight.values()].reduce((t, v) => t.plus(v), ZERO);
  if (!spreadTotal.isZero()) {
    if (weightSum.isZero()) {
      problems.push("There is a cost to spread across the groups but no own-works lines to spread it by.");
      unmapped.push({ key: "spread", label: "Spread allocation", amount: spreadTotal });
    } else for (const gid of groups.keys()) bump(hidden, gid, spreadTotal.times(ownWeight.get(gid)!).div(weightSum));
  }

  const { a, b } = "line" in pricing ? pricing.line : { a: ONE.plus(d(pricing.overheadRate)).div(ONE.minus(d(pricing.margin))), b: ZERO };
  const lineSum = (g: ScheduleGroup) => g.lines.filter((ln) => ln.kind !== "margin").reduce((t, ln) => t.plus(amt.get(ln.ref)!), ZERO);
  const packageCost = schedule.groups.reduce((t, g) => t.plus(lineSum(g)).plus(hidden.get(g.id)!), ZERO);

  const outGroups: PricedGroup[] = [];
  let totalSell = ZERO;
  for (const g of schedule.groups) {
    const gid = g.id;
    const cost = lineSum(g).plus(hidden.get(gid)!);
    const sell = cost.times(a).plus(packageCost.isZero() ? ZERO : b.times(cost).div(packageCost));
    const lines: PricedLine[] = [];
    let shown = ZERO;
    for (const ln of g.lines) {
      if (ln.kind === "margin") continue;
      const r = cents(amt.get(ln.ref)!);
      shown = shown.plus(r);
      lines.push({ ref: ln.ref, trade: ln.trade, kind: ln.kind, amount: r, sources: srcOnLine.get(ln.ref)! });
    }
    const total = cents(sell);
    const marginAmt = total.minus(shown);
    // the Margin line keeps its place in the group's order
    let k = 0;
    const full: PricedLine[] = g.lines.map((ln) =>
      ln.kind === "margin" ? { ref: ln.ref, trade: ln.trade, kind: "margin", amount: marginAmt, sources: [], hidden: cents(hidden.get(gid)!) } : lines[k++]!,
    );
    outGroups.push({
      id: gid, name: g.name, code: g.code ?? "", lines: full, subtotal: full.filter((x) => x.kind === "work").reduce((t, x) => t.plus(x.amount), ZERO),
      cost: cents(cost), hidden: cents(hidden.get(gid)!), total,
    });
    totalSell = totalSell.plus(total);
  }

  // Each group is rounded to the cent on its own, so several groups can miss the package by a cent or two. When everything is
  // mapped, put that rounding on the largest group (its Margin line) so the printed groups always add up to the all-in exactly.
  const gap = cents(allIn).minus(outGroups.reduce((t, g) => t.plus(g.total), ZERO));
  if (!gap.isZero() && unmapped.length === 0 && problems.length === 0 && gap.abs().lte(new D("0.01").times(outGroups.length)) && outGroups.length) {
    const big = outGroups.reduce((m, g) => (g.total.gt(m.total) ? g : m));
    big.total = big.total.plus(gap);
    for (const ln of big.lines) if (ln.kind === "margin") ln.amount = ln.amount.plus(gap);
    totalSell = totalSell.plus(gap);
  }

  const gross = sources.reduce((t, s) => t.plus(d(s.amount)), ZERO);
  const mappedTotal = gross.minus(unmapped.reduce((t, u) => t.plus(u.amount), ZERO));
  const diff = cents(totalSell).minus(cents(allIn));
  const ok = unmapped.length === 0 && problems.length === 0 && diff.abs().lt(HALF_CENT);
  if (diff.abs().gte(HALF_CENT) && unmapped.length === 0 && problems.length === 0)
    problems.push(`The schedule totals ${money(totalSell)} but the tender is ${money(allIn)}.`);
  return {
    name: schedule.name ?? "", client: schedule.client ?? "", groups: outGroups, total: cents(totalSell), allIn: cents(allIn), difference: diff,
    unmapped, problems, reconciles: ok, grossPackage: cents(gross), mapped: cents(mappedTotal),
  };
}

/**
 * Build a schedule format from pasted text, e.g. copied from the client's Excel price schedule.
 *
 *   # MAIN BUILDING | A          <- a group heading ('#' or '##'), optional short code after '|'
 *   MB/001   Excavation          <- ref, then trade (tab, two spaces or a single space between)
 *   MB/025   Preliminaries & General   [pg]
 *   MB/026   Margin              [margin]
 *
 * A group with no [margin] line gets one added at the end. Lines starting with '-' or blank lines are ignored.
 */
export function parseFormat(text: string, name = "", client = ""): Schedule {
  const groups: ScheduleGroup[] = [];
  let cur: ScheduleGroup | null = null;
  const refs = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim().replace(/^﻿|﻿$/g, "");
    if (!line || line.startsWith("-")) continue;
    if (line.startsWith("#")) {
      const head = line.replace(/^#+/, "").trim();
      const bar = head.indexOf("|");
      const title = bar < 0 ? head : head.slice(0, bar);
      const code = bar < 0 ? "" : head.slice(bar + 1);
      cur = { id: `g${groups.length + 1}`, name: title.trim().toUpperCase(), code: code.trim(), lines: [] };
      if (!cur.name) throw new ScheduleError("A group heading needs a name.");
      groups.push(cur);
      continue;
    }
    if (cur === null) throw new ScheduleError("Start with a group heading, for example '# CIVIL WORKS'.");
    let kind: LineKind = "work";
    const m = /\[(pg|margin|work)\]\s*$/i.exec(line);
    if (m) {
      kind = m[1]!.toLowerCase() as LineKind;
      line = line.slice(0, m.index).trim();
    }
    let ps = splitOnce(line, /\t+|\s{2,}/);
    if (ps.length < 2) ps = splitOnce(line, /\s+/);
    if (ps.length < 2 || !ps[1]!.trim()) throw new ScheduleError(`Line '${line}' needs a reference and a trade name.`);
    const ref = ps[0]!.trim(), trade = ps[1]!.trim();
    if (refs.has(ref)) throw new ScheduleError(`Reference '${ref}' appears twice.`);
    refs.add(ref);
    cur.lines.push({ ref, trade, kind });
  }
  if (groups.length === 0) throw new ScheduleError("Paste the client's schedule lines first.");
  for (const g of groups) {
    if (g.lines.length === 0) throw new ScheduleError(`Group '${g.name}' has no lines.`);
    const margins = g.lines.filter((ln) => ln.kind === "margin");
    if (margins.length > 1) throw new ScheduleError(`Group '${g.name}' has more than one Margin line.`);
    if (margins.length === 0) {
      let ref = `${g.code || g.id}/M`;
      while (refs.has(ref)) ref += "x";
      refs.add(ref);
      g.lines.push({ ref, trade: "Margin", kind: "margin" });
    }
  }
  const s: Schedule = { name: name.trim(), client: client.trim(), groups, map: {} };
  validateSchedule(s);
  return s;
}

function splitOnce(line: string, sep: RegExp): string[] {
  const m = sep.exec(line);
  if (!m) return [line];
  return [line.slice(0, m.index), line.slice(m.index + m[0].length)];
}

export function validTarget(s: Schedule, target: string): boolean {
  const refs = new Set(s.groups.flatMap((g) => g.lines.filter((ln) => ln.kind !== "margin").map((ln) => ln.ref)));
  const ids = new Set(s.groups.map((g) => g.id));
  return target === "spread" || (target.startsWith("line:") && refs.has(target.slice(5))) || (target.startsWith("group:") && ids.has(target.slice(6)));
}
