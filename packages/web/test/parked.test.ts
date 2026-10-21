import { describe, expect, it } from "vitest";
import type { RecordData } from "@blackline/tender/core";
import type { ServerRecord } from "../src/lib/draft.js";
import { applyParked, compareParked, diffBodies, fieldName, labelOf, mergeTheirs, show, type Parked } from "../src/lib/parked.js";

const row = (uid: string, over: object = {}): RecordData => ({ kind: "row", seq: 0, body: { uid, task: "Supervisor", jobRateOverride: "70", manualQty: null, verified: "No", ...over } });

// The story: Eli took package p1 at version 1. While he was away, Carlo changed A-001's rate to 99 and checked in (version 2).
// Eli's refused check-in carries his whole copy of the records, with his own edits on top of the old values.
const base: Record<string, RecordData | null> = { "row:A-001": row("A-001"), "row:A-002": row("A-002", { waste: "0" }), "row:A-003": row("A-003") };
const server: ServerRecord[] = [
  { id: "row:A-001", packageId: "p1", data: row("A-001", { jobRateOverride: "99" }) }, // Carlo's change
  { id: "row:A-002", packageId: "p1", data: row("A-002", { waste: "0" }) },
  { id: "row:A-003", packageId: "p1", data: row("A-003") },
  { id: "row:B-001", packageId: "p2", data: row("B-001") },
];
const parked = (upserts: Record<string, RecordData>, deletes: string[] = [], b = base): Parked => ({
  id: "x", package_id: "p1", package_name: "Earthworks", holder: "u", holder_name: "Eli", base_version: 1, reason: "no-lock", created_at: "2026-10-21T00:00:00Z",
  changes: { upserts, deletes }, base: b,
});
const eli = parked(
  { "row:A-001": row("A-001", { manualQty: "7", verified: "Yes" }), "row:A-002": row("A-002", { waste: "0.1" }), "row:A-099": row("A-099", { jobRateOverride: "1500" }) },
  ["row:A-003"],
);

describe("comparing a parked change with what is there now", () => {
  it("shows only the fields they changed, not their old copy of fields someone else has since changed", () => {
    const c = compareParked(eli, server).find((x) => x.recordId === "row:A-001")!;
    expect(c.kind).toBe("changed");
    expect(c.fields.map((f) => f.field).sort()).toEqual(["manualQty", "verified"]); // Carlo's jobRateOverride is not Eli's to undo
    expect(c.fields.every((f) => f.status === "theirs-only")).toBe(true);
  });

  it("marks a field both people changed as a conflict, and one that already matches as the same", () => {
    const both = parked({ "row:A-001": row("A-001", { jobRateOverride: "80" }), "row:A-002": row("A-002", { waste: "0" }) });
    const c = Object.fromEntries(compareParked(both, server).map((x) => [x.recordId, x]));
    expect(c["row:A-001"]!.fields).toEqual([{ field: "jobRateOverride", base: "70", current: "99", theirs: "80", status: "both" }]);
    expect(c["row:A-002"]!.kind).toBe("same");
    const matches = parked({ "row:A-001": row("A-001", { jobRateOverride: "99" }) });
    expect(compareParked(matches, server)[0]!.kind).toBe("same"); // they set it to what it already is
  });

  it("lists added and deleted records, and warns when a deleted record has changed since", () => {
    const c = Object.fromEntries(compareParked(eli, server).map((x) => [x.recordId, x]));
    expect(c["row:A-099"]!.kind).toBe("added");
    expect(c["row:A-003"]!.kind).toBe("removed");
    expect(c["row:A-003"]!.note).toBeUndefined();
    const stale = compareParked(parked({}, ["row:A-001"]), server)[0]!;
    expect(stale.kind).toBe("removed");
    expect(stale.note).toMatch(/changed this record since/);
  });

  it("falls back to a plain comparison when there is no starting point on record", () => {
    const noBase = parked({ "row:A-001": row("A-001", { manualQty: "7" }) }, [], undefined as any);
    const f = compareParked({ ...noBase, base: undefined }, server)[0]!.fields;
    expect(f.map((x) => [x.field, x.status])).toEqual([["jobRateOverride", "unknown"], ["manualQty", "unknown"]]);
  });

  it("compares against the package it was refused from, not records with the same id elsewhere", () => {
    const other: ServerRecord[] = [...server, { id: "row:A-001", packageId: "p9", data: row("A-001", { manualQty: "zzz" }) }];
    expect(compareParked(eli, other).find((x) => x.recordId === "row:A-001")!.fields.map((f) => f.current)).toEqual([null, "No"]);
  });
});

describe("taking their changes", () => {
  it("merges only the fields they changed into the current record", () => {
    const c = compareParked(eli, server).find((x) => x.recordId === "row:A-001")!;
    const merged = mergeTheirs(server[0]!.data, c).body as any;
    expect([merged.manualQty, merged.verified]).toEqual(["7", "Yes"]);
    expect(merged.jobRateOverride).toBe("99"); // Carlo's work is kept
  });

  it("applies the whole parked change for the price effect: merged fields, added records, deletions, own package only", () => {
    const after = applyParked(server, eli);
    expect(after.map((r) => r.id).sort()).toEqual(["row:A-001", "row:A-002", "row:A-099", "row:B-001"]);
    const a1 = after.find((r) => r.id === "row:A-001")!.data.body as any;
    expect([a1.jobRateOverride, a1.manualQty]).toEqual(["99", "7"]);
    expect(after.find((r) => r.id === "row:A-099")!.packageId).toBe("p1");
    expect((server[0]!.data.body as any).manualQty).toBeNull(); // the originals are untouched
  });
});

describe("wording", () => {
  it("names records and fields for people", () => {
    expect(diffBodies({ a: 1, b: "x", c: null }, { a: 1, b: "y", d: 2 })).toEqual([{ field: "b", from: "x", to: "y" }, { field: "d", from: undefined, to: 2 }]);
    expect(labelOf("qs:EW01", { kind: "qs", body: { code: "EW01", description: "Strip" } })).toBe("EW01 Strip");
    expect(labelOf("ca:CA17", { kind: "ca", body: { ref: "CA17", name: "Overhead" } })).toBe("CA17 Overhead");
    expect(fieldName("jobRateOverride")).toBe("Job rate override");
    expect([show(null), show(""), show("5"), show(0)]).toEqual(["(blank)", "(blank)", "5", "0"]);
  });
});
