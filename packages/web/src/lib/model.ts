/**
 * The workbench model: everything the screens show, derived from records by the shared tender engine (the same code the server
 * runs). Called on every edit; for a whole job this is a few milliseconds, so there is no separate "recalculate" step.
 */
import { D, ZERO, type Dec } from "@blackline/engine";
import { assembleInputs, computeTenderEstimate, type BuildUpRow, type RowResult } from "@blackline/tender/core";
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

export interface Model {
  estimate: ReturnType<typeof computeTenderEstimate>;
  qsRows: QsRow[];
  buildups: Map<string, BuildupRow[]>;
  /** QS code -> the package that holds it */
  packageOfQs: Map<string, string>;
  /** Build-up cost whose QS code is not in the takeoff: it still counts in the price, so the screen says so. */
  orphanCost: Dec;
}

const BLOCKING = new Set(["RESOURCE CODE", "RATE MISSING", "OPERATOR DOUBLE-COUNT", "FUEL DOUBLE-COUNT"]);

export function buildModel(records: ServerRecord[]): Model {
  const inputs = assembleInputs(records.map((r) => ({ id: r.id, data: r.data })));
  const estimate = computeTenderEstimate(inputs);

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
  return { estimate, qsRows, buildups, packageOfQs, orphanCost: estimate.qs.orphanCost };
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
