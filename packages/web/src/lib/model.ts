/**
 * The workbench model: everything the screens show, derived from records by the shared tender engine (the same code the server
 * runs). Called on every edit; for a whole job this is a few milliseconds, so there is no separate "recalculate" step.
 */
import { D, ZERO, type Dec } from "@blackline/engine";
import { assembleInputs, computeTenderEstimate, gantt as G, type BuildUpRow, type RowResult, type TenderInputs } from "@blackline/tender/core";
import type { ServerRecord } from "./draft.js";

export interface QsRow {
  kind: "section" | "item";
  key: string;
  code: string;
  section: string;
  description: string;
  unit: string;
  quantity: string;
  amount: Dec;
  rate: Dec | null;
  rows: number;
  flags: number;
  recordId: string;
  packageId: string;
}

export interface BuildupRow {
  recordId: string;
  packageId: string;
  uid: string;
  rowId: string;
  src: BuildUpRow;
  res: RowResult;
  resource: string;
}

export interface LibraryRow {
  recordId: string;
  packageId: string;
  code: string;
  category: string;
  description: string;
  unit: string;
  baseRate: string;
  operatorIncluded: string;
  fuelIncluded: string;
  source: string;
  /** Build-up rows that use this rate, and the cost they carry at today's rates */
  usedBy: number;
  cost: Dec;
  /** Made by the labour builder: its price comes from a saved build-up, and it can't be deleted */
  built: boolean;
}

export interface Model {
  estimate: ReturnType<typeof computeTenderEstimate>;
  qsRows: QsRow[];
  buildups: Map<string, BuildupRow[]>;
  library: LibraryRow[];
  /** The package that holds the rate library ('' when the job has none) */
  libraryPackageId: string;
  /** QS code -> the package that holds it */
  packageOfQs: Map<string, string>;
  /** Build-up cost whose QS code is not in the takeoff: it still counts in the price, so the screen says so. */
  orphanCost: Dec;
  /** Saved labour build-ups by library code */
  labourBuilds: NonNullable<TenderInputs["labourBuilds"]>;
  /** The tender register (documents, assumptions, exclusions, RFIs, risks) and the supplier quote register */
  register: NonNullable<TenderInputs["register"]>;
  quotes: NonNullable<TenderInputs["quotes"]>;
  /** The commercial lines as typed (CA01.., and allowances CX01..), the subcontract packages, the confirmed overlap, and whether the
   *  Management Reserve block (not CA16's own number) feeds CA16 */
  commercial: TenderInputs["commercial"];
  overlays: TenderInputs["overlays"];
  overlap: string;
  reserveLinked: boolean;
  /** The tender programme as stored (null when the job has none yet) */
  programme: TenderInputs["programme"];
  /** The Gantt: the project, its tasks in row order with their seqs, the schedule worked out from them, and the package that holds it (null until started) */
  gantt: G.GProject | null;
  ganttRows: { task: G.GTask; seq: number }[];
  ganttSchedule: G.ScheduleResult | null;
  ganttPackageId: string;
  /** Every record id the Gantt package holds, so a replacement can clear what it doesn't keep */
  ganttRecordIds: string[];
}

const BLOCKING = new Set(["RESOURCE CODE", "RATE MISSING", "OPERATOR DOUBLE-COUNT", "FUEL DOUBLE-COUNT"]);

export function buildModel(records: ServerRecord[]): Model {
  const inputs = assembleInputs(records.map((r) => ({ id: r.id, data: r.data })));
  const estimate = computeTenderEstimate(inputs);

  const ganttProject = G.assembleGantt(records.map((r) => ({ id: r.id, data: r.data })));
  const ganttRows = records.filter((r) => r.data.kind === "ganttTask").map((r) => ({ task: r.data.body as G.GTask, seq: r.data.seq ?? 0 })).sort((a, b) => a.seq - b.seq);
  const pkgOf = new Map<string, string>(); // record id -> package id
  for (const r of records) pkgOf.set(r.id, r.packageId);
  const packageOfQs = new Map(inputs.qs.map((q) => [q.code, pkgOf.get(`qs:${q.code}`) ?? ""]));

  const lib = new Map(inputs.library.map((l) => [l.code, l.description ?? ""]));
  const coded = inputs.rows.filter((r) => r.qsCode); // the engine skips rows without a QS code; results line up with these
  const buildups = new Map<string, BuildupRow[]>();
  coded.forEach((src, i) => {
    const recordId = `row:${src.uid}`;
    const row: BuildupRow = {
      recordId, packageId: pkgOf.get(recordId) ?? packageOfQs.get(src.qsCode) ?? "", uid: src.uid ?? "", rowId: estimate.rows[i]!.rowId,
      src, res: estimate.rows[i]!, resource: lib.get(src.resourceCode) ?? "",
    };
    buildups.set(src.qsCode, [...(buildups.get(src.qsCode) ?? []), row]);
  });

  const qsRows: QsRow[] = [];
  const sections: string[] = [];
  for (const l of estimate.qs.lines) if (!sections.includes(l.section)) sections.push(l.section);
  for (const section of sections) {
    qsRows.push({
      kind: "section", key: `s:${section}`, code: "", section, description: section, unit: "", quantity: "",
      amount: estimate.qs.sectionTotals.get(section) ?? ZERO, rate: null, rows: 0, flags: 0, recordId: "", packageId: "",
    });
    for (const l of estimate.qs.lines.filter((x) => x.section === section)) {
      const rows = buildups.get(l.code) ?? [];
      const q = inputs.qs.find((x) => x.code === l.code)!;
      qsRows.push({
        kind: "item", key: `q:${l.code}`, code: l.code, section, description: l.description, unit: l.unit, quantity: String(q.quantity ?? ""),
        amount: l.amount, rate: l.quantity.isZero() ? null : l.rate, rows: rows.length, flags: rows.filter((r) => r.res.qaFlag !== "OK").length,
        recordId: `qs:${l.code}`, packageId: packageOfQs.get(l.code) ?? "",
      });
    }
  }
  const usage = new Map<string, { n: number; cost: Dec }>();
  coded.forEach((src, i) => {
    const u = usage.get(src.resourceCode) ?? { n: 0, cost: ZERO };
    usage.set(src.resourceCode, { n: u.n + 1, cost: u.cost.plus(estimate.rows[i]!.cost) });
  });
  const library: LibraryRow[] = inputs.library.map((l) => ({
    recordId: `library:${l.code}`, packageId: pkgOf.get(`library:${l.code}`) ?? "", code: l.code, category: String(l.category ?? ""), description: String(l.description ?? ""),
    unit: String(l.unit ?? ""), baseRate: String(l.baseRate ?? ""), operatorIncluded: String(l.operatorIncluded ?? ""), fuelIncluded: String(l.fuelIncluded ?? ""),
    source: String(l.source ?? ""), usedBy: usage.get(l.code)?.n ?? 0, cost: usage.get(l.code)?.cost ?? ZERO, built: !!inputs.labourBuilds?.[l.code],
  }));
  return { estimate, qsRows, buildups, library, libraryPackageId: library[0]?.packageId ?? "", packageOfQs, orphanCost: estimate.qs.orphanCost, labourBuilds: inputs.labourBuilds ?? {}, register: inputs.register ?? [], quotes: inputs.quotes ?? [],
    commercial: inputs.commercial, overlays: inputs.overlays, overlap: String(inputs.overlap ?? "0"), reserveLinked: !!inputs.managementReserve, programme: inputs.programme ?? null,
    gantt: ganttProject, ganttRows, ganttSchedule: ganttProject ? G.schedule(ganttProject) : null, ganttPackageId: pkgOf.get("gantt:config") ?? "",
    ganttRecordIds: records.filter((r) => /^(gantt|gtask|gcal|gres|gasg):/.test(r.id)).map((r) => r.id) };
}

export const isBlocking = (flag: string) => BLOCKING.has(flag);

/** The next free build-up row id for a QS code, e.g. "EW01-004" (display ids are positional; this one is the permanent uid). */
export function nextUid(qsCode: string, existing: string[]): string {
  const taken = new Set(existing);
  for (let n = 1; ; n++) {
    const uid = `${qsCode}-${String(n).padStart(3, "0")}`;
    if (!taken.has(uid)) return uid;
  }
}

export const total = (qsRows: QsRow[]): Dec => qsRows.filter((r) => r.kind === "item").reduce((t, r) => t.plus(r.amount), new D(0));
