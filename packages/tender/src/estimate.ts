/**
 * Assemble a complete estimate from the tender inputs by running every engine, ported from QSi Pro
 * (engine/tender_engine/estimate.py). Every number returned is recomputed by the engine; `reconciliation` compares key
 * engine totals to the values a source workbook displayed, so the estimator can see the platform agrees with it.
 */
import { cents, D, type Dec, ZERO } from "@blackline/engine";
import { computeBuildup } from "./buildup.js";
import { computeTender, isPreMargin, packageSellLine, type TenderResult } from "./commercial.js";
import { computeConsolidated } from "./consolidated.js";
import { computeLabourRate, type LabourResult } from "./labourRate.js";
import { computeReserve, type ReserveBlock, type ReserveResult } from "./managementReserve.js";
import { d, type BuildUpRow, type CommercialInput, type LibraryRate, type Num, type Overlay, type QSItem, type WeatherToolRun } from "./models.js";
import { computeProgramme, type Programme } from "./programme.js";
import { computeQs } from "./qs.js";
import type { Quote } from "./quotes.js";
import { statusSummary, type RegisterItem } from "./register.js";
import { computeRiskTruth, numOrNull, type Exposure } from "./riskTruth.js";
import { autoMap, computeSchedule, defaultSchedule, type Schedule, type ScheduleSource } from "./schedule.js";
import { computeScope, type ScopeItem } from "./scope.js";
import { computeWeather, type WeatherResult } from "./weather.js";
import { exposedByQs, runSetup, type WeatherSetup } from "./weatherSetup.js";

export interface CommercialLine extends CommercialInput {
  basis?: string;
  note?: string;
}

export interface TenderInputs {
  meta?: Record<string, unknown>;
  library: LibraryRate[];
  qs: QSItem[];
  rows: BuildUpRow[];
  /** Weather-linked build-up rows: the daily prelims row and the weekly hire rows, by row uid. */
  weatherLinks: { dailyUid: string; hoursPerDay: Num; weeklyUids: string[] };
  /** baseline_wd and wd_per_week are used when no live setup is present. */
  weatherMeta?: Record<string, unknown>;
  recovery?: Num;
  /** Recorded Weather Tool outputs, replaced by the live run when `weatherSetup` is present. */
  tool: WeatherToolRun;
  weatherSetup?: WeatherSetup | null;
  commercial: CommercialLine[];
  /** Value delivered by Risk Engine lines when Risk Truth has no exposures (a workbook's recorded feed). */
  riskFeed?: Record<string, Num>;
  riskTruth?: Exposure[];
  register?: RegisterItem[];
  managementReserve?: ReserveBlock | null;
  overlays: Overlay[];
  overlap?: Num;
  schedule?: Schedule | null;
  quotes?: Quote[];
  scope?: ScopeItem[];
  programme?: Programme | null;
  /** Labour true-cost builds by library code, with the earlier builds kept as history. */
  labourBuilds?: Record<string, { inputs: Record<string, unknown>; history?: { rate: string; status: string; evidence: string; source_date: string }[] }>;
  /** Values the source workbook displayed, for reconciliation. Null once the tender has been edited in the platform. */
  reference?: Record<string, Num> | null;
}

export interface Reconciliation {
  name: string;
  engine: Dec;
  workbook: Dec;
  difference: Dec;
  ok: boolean;
}

const sum = (xs: Iterable<Dec>) => [...xs].reduce((t, x) => t.plus(x), ZERO);

/** Sell effect of one dollar of pre-margin reserve cost, taken through the commercial engine itself. */
function reserveFactor(commercial: CommercialInput[], baseDirect: Dec): Dec {
  if (!commercial.some((c) => c.ref === "CA16")) return new D(1);
  const bump = new D(1000);
  const withReserve = (extra: Dec) =>
    commercial.map((c) =>
      c.ref === "CA16" ? { ...c, include: "Yes", method: "Management Reserve", engineValue: (c.include === "Yes" ? d(c.engineValue) : ZERO).plus(extra) } : c,
    );
  return computeTender(baseDirect, withReserve(bump)).tenderExclGst.minus(computeTender(baseDirect, withReserve(ZERO)).tenderExclGst).div(bump);
}

export function computeTenderEstimate(m: TenderInputs) {
  const qsByCode = new Map(m.qs.map((q) => [q.code, q]));
  const library = new Map(m.library.map((r) => [r.code, r]));
  const rows = computeBuildup(m.rows, qsByCode, library);
  const qs = computeQs(m.qs, rows);

  // build-up rows that have a QS code, in order: the same list the results are returned for
  const coded = m.rows.filter((r) => r.qsCode);
  const byUid = new Map(coded.map((src, i) => [src.uid ?? "", rows[i]!]));
  const rateOf = (uid: string) => byUid.get(uid)?.appliedRate ?? ZERO;

  const wl = m.weatherLinks;
  const dailyPrelims = rateOf(wl.dailyUid).times(d(wl.hoursPerDay));
  const weeklyHire = sum(wl.weeklyUids.map(rateOf));
  const recovery = d(m.recovery);

  let tool = m.tool;
  let toolOut: { warnings: string[]; confidence: string; redFlags: string[] } | null = null;
  if (m.weatherSetup) {
    // live weather tool: the platform's own run replaces the recorded tool outputs
    const { result: tr, warnings } = runSetup(m.weatherSetup, exposedByQs(coded, rows), dailyPrelims, weeklyHire, recovery);
    const rain = tr.directAllowance.minus(tr.includeWind ? tr.windSensitivity : ZERO);
    tool = {
      exposedPool: sum(rows.map((r) => r.weatherExposedCost)), rainWetGroundCost: rain, criticalPathDelayWd: tr.criticalPathDelayWd,
      additionalBilledWeeks: tr.additionalBilledWeeks, windSensitivityCost: tr.windSensitivity, includeWind: tr.includeWind, live: true,
    };
    toolOut = { warnings, confidence: tr.confidence, redFlags: tr.redFlags };
  }
  const weather: WeatherResult = computeWeather(rows, tool, { dailyPrelims, weeklyHire, recoveryAllowance: recovery });

  const register = m.register ?? [];
  const riskTruthItems = m.riskTruth ?? [];
  const rtr = computeRiskTruth(riskTruthItems, register.filter((x) => x.kind === "risk"));
  // live Risk Truth feeds CA01 / CA02 once exposures exist (and always on a tender edited in the platform); a workbook that has
  // no Risk Truth tab keeps its recorded feed
  const liveRt = riskTruthItems.length > 0 || m.reference === null || m.reference === undefined;

  const commercial: CommercialInput[] = m.commercial.map((c) => {
    let ev: Dec;
    let method = c.method;
    if (c.method === "Weather Engine") ev = weather.allowance;
    else if (liveRt && (c.ref === "CA01" || c.ref === "CA02")) ev = c.ref === "CA01" ? rtr.ca01 : rtr.ca02;
    else if (m.managementReserve && c.ref === "CA16") {
      ev = numOrNull(m.managementReserve.selected) ?? ZERO;
      method = "Management Reserve";
    } else ev = d(m.riskFeed?.[c.ref]);
    return { ref: c.ref, name: c.name, method, include: c.include, pct: c.pct, pcSum: c.pcSum, engineValue: ev };
  });

  const tender: TenderResult = computeTender(qs.totalDirect, commercial);
  const cmap = new Map(commercial.map((c) => [c.ref, c]));
  const cons = computeConsolidated(tender.subtotal, m.overlays, m.overlap, { commercial });

  let reserve: ReserveResult | null = null;
  if (m.managementReserve) {
    const exposures = riskTruthItems.map((x, i) => ({ ref: x.ref, addition: rtr.exposures[i]!.addition }));
    reserve = computeReserve(m.managementReserve, reserveFactor(commercial, qs.totalDirect), exposures, tender.subtotal);
  }

  // ---- reconciliation against what the source workbook displayed (only for an unedited import)
  const engineTotals: [string, Dec][] = [
    ["Base direct estimate", qs.totalDirect], ["Pre-margin additions", tender.preMarginTotal], ["Subtotal before commercial adjustments", tender.subtotal],
    ["Company overhead (CA17)", tender.overhead], ["Contractor profit (CA18)", tender.profit], ["Own works tender excl. GST", tender.tenderExclGst],
    ["Weather allowance (CA10)", weather.allowance], ["Gross known package", cons.grossKnownPackage], ["Working all-in tender excl. GST", cons.allInTender],
  ];
  const reconciliation: Reconciliation[] = [];
  if (m.reference) {
    for (const [name, engine] of engineTotals) {
      if (!(name in m.reference)) continue; // a figure this workbook doesn't have
      const wb = d(m.reference[name]);
      reconciliation.push({ name, engine: cents(engine), workbook: cents(wb), difference: cents(engine).minus(cents(wb)), ok: engine.minus(wb).abs().lt("0.005") });
    }
  }

  // ---- client price schedule (custom format, or an automatic one by QS section)
  const caRefs = [...tender.additions].filter(([, amt]) => !amt.isZero()).map(([ref]) => ref);
  const sources: ScheduleSource[] = [
    ...qs.lines.map((l) => ({ key: `qs:${l.code}`, label: `${l.code} ${l.description}`, amount: l.amount, own: true })),
    ...caRefs.map((ref) => ({ key: `ca:${ref}`, label: `${ref} ${cmap.get(ref)!.name}`, amount: tender.additions.get(ref)!, own: true })),
    ...m.overlays.map((o) => ({ key: `overlay:${o.name}`, label: o.name, amount: o.amount, own: false })),
  ];
  const autoSchedule = !m.schedule;
  let sched: Schedule;
  if (!m.schedule) {
    sched = defaultSchedule([...new Set(qs.lines.map((l) => l.section))], m.overlays.map((o) => o.name));
    sched.map = autoMap(sched, qs.lines.map((l) => ({ code: l.code, section: l.section })), m.overlays.map((o) => ({ name: o.name })), caRefs);
  } else sched = m.schedule;
  const schedule = computeSchedule(sched, sources, cons.allInTender, { line: packageSellLine(cmap) });

  // ---- programme
  const qsInfo = Object.fromEntries(qs.lines.map((l) => [l.code, { section: l.section, description: l.description, amount: Number(l.amount.toString()) }]));
  let programme: ReturnType<typeof computeProgramme> | { setUp: false; missing: { code: string; description: string; amount: number }[] };
  if (!m.programme) {
    programme = { setUp: false, missing: Object.entries(qsInfo).filter(([, i]) => i.amount).map(([code, i]) => ({ code, description: i.description, amount: i.amount })) };
  } else {
    const hours = new Map<string, Dec>();
    for (const r of rows) {
      if (!qsInfo[r.qsCode]?.amount) continue; // reference-only items (no cost) carry no duration of their own
      if (r.appliedDurationHrs.gt(0) && r.appliedDurationHrs.gt(hours.get(r.qsCode) ?? ZERO)) hours.set(r.qsCode, r.appliedDurationHrs);
    }
    programme = computeProgramme(m.programme, hours, qsInfo);
  }

  // ---- scope coverage
  const costs: Record<string, Dec> = Object.fromEntries(qs.lines.map((l) => [l.code, l.amount]));
  for (const [ref, amt] of tender.additions) costs[ref] = amt;
  const scope = computeScope(m.scope ?? [], costs, register, new Set((m.quotes ?? []).filter((q) => q.ref).map((q) => q.ref.toUpperCase())));

  // a build that fails its own checks is reported, not allowed to break the whole job
  const labourBuilds: Record<string, LabourResult> = {};
  const labourBuildErrors: Record<string, string> = {};
  for (const [code, b] of Object.entries(m.labourBuilds ?? {})) {
    try { labourBuilds[code] = computeLabourRate(b.inputs); } catch (e) { labourBuildErrors[code] = e instanceof Error ? e.message : String(e); }
  }

  const qaCounts: Record<string, number> = {};
  for (const r of rows) qaCounts[r.qaFlag] = (qaCounts[r.qaFlag] ?? 0) + 1;

  return {
    rows, qs, weather, weatherTool: toolOut, riskTruth: rtr, commercial, tender, consolidated: cons, reserve, reconciliation,
    reconciled: m.reference ? reconciliation.every((r) => r.ok) : null, edited: m.reference === null || m.reference === undefined,
    schedule, scheduleIsAuto: autoSchedule || !!sched.auto, programme, scope, qaCounts,
    registerSummary: statusSummary(register),
    labourBuilds,
    labourBuildErrors,
    summary: {
      allIn: cons.allInTender, siteworksTender: tender.tenderExclGst, knownCost: cons.grossKnownPackage, siteworksPrecommercial: tender.subtotal,
      managementReserve: tender.additions.get("CA16"), weatherAllowance: weather.allowance, grossMarginOnSell: cons.grossMarginOnSell, baseDirect: tender.baseDirect,
    },
    isPreMargin,
  };
}
