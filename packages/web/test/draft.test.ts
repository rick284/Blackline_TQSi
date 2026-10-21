import { describe, expect, it } from "vitest";
import type { RecordData } from "@blackline/tender/core";
import { addRecord, changeSetOf, countChanges, deleteRecord, discardPackage, editRecord, effectiveRecords, parseNumberCell, type Drafts, type ServerRecord } from "../src/lib/draft.js";
import { money, num, pct } from "../src/lib/fmt.js";

const rec = (id: string, packageId: string, body: object, seq = 0): ServerRecord => ({ id, packageId, data: { kind: "row", seq, body } as RecordData });
const server: ServerRecord[] = [rec("row:A-001", "p1", { qsCode: "A", jobRateOverride: "10" }), rec("row:A-002", "p1", { qsCode: "A", jobRateOverride: "20" }), rec("row:B-001", "p2", { qsCode: "B" })];

describe("drafts", () => {
  it("overlays an edit on the server's record and leaves the server alone", () => {
    const d = editRecord({}, server, "p1", "row:A-001", (b) => ({ ...b, jobRateOverride: "99" }));
    const eff = effectiveRecords(server, d);
    expect((eff.find((r) => r.id === "row:A-001")!.data.body as any).jobRateOverride).toBe("99");
    expect((server[0]!.data.body as any).jobRateOverride).toBe("10");
    expect(countChanges(d)).toBe(1);
  });

  it("stops counting an edit that is put back to the server's value", () => {
    let d: Drafts = editRecord({}, server, "p1", "row:A-001", (b) => ({ ...b, jobRateOverride: "99" }));
    d = editRecord(d, server, "p1", "row:A-001", (b) => ({ ...b, jobRateOverride: "10" }));
    expect(d).toEqual({});
  });

  it("builds a change set from drafts for one package only", () => {
    let d: Drafts = editRecord({}, server, "p1", "row:A-001", (b) => ({ ...b, jobRateOverride: "99" }));
    d = deleteRecord(d, server, "p1", "row:A-002");
    d = editRecord(d, server, "p2", "row:B-001", (b) => ({ ...b, x: 1 }));
    const cs = changeSetOf("p1", d);
    expect(Object.keys(cs.upserts)).toEqual(["row:A-001"]);
    expect(cs.deletes).toEqual(["row:A-002"]);
    expect(countChanges(d, "p1")).toBe(2);
    expect(countChanges(d, "p2")).toBe(1);
  });

  it("hides a deleted record, shows a new one, and forgets a new record that is deleted again", () => {
    let d = deleteRecord({}, server, "p1", "row:A-002");
    expect(effectiveRecords(server, d).map((r) => r.id)).toEqual(["row:A-001", "row:B-001"]);
    d = addRecord(d, "p1", "row:A-003", { kind: "row", seq: 9, body: { qsCode: "A" } });
    expect(effectiveRecords(server, d).map((r) => r.id)).toEqual(["row:A-001", "row:B-001", "row:A-003"]);
    d = deleteRecord(d, server, "p1", "row:A-003");
    expect(effectiveRecords(server, d).map((r) => r.id)).toEqual(["row:A-001", "row:B-001"]);
  });

  it("discards one package's drafts and no others", () => {
    let d: Drafts = editRecord({}, server, "p1", "row:A-001", (b) => ({ ...b, x: 1 }));
    d = editRecord(d, server, "p2", "row:B-001", (b) => ({ ...b, x: 1 }));
    expect(Object.keys(discardPackage(d, "p1"))).toEqual(["p2"]);
  });

  it("will not edit a record that does not exist in the package", () => {
    expect(() => editRecord({}, server, "p1", "row:nope", (b) => b)).toThrow(/No record/);
  });
});

describe("number cells", () => {
  it("accepts plain decimals, clears on blank, and rejects words", () => {
    expect(parseNumberCell("12.5")).toEqual({ ok: true, value: "12.5" });
    expect(parseNumberCell(" 1,234.50 ")).toEqual({ ok: true, value: "1234.50" });
    expect(parseNumberCell(".5")).toEqual({ ok: true, value: ".5" });
    expect(parseNumberCell("-3")).toEqual({ ok: true, value: "-3" });
    expect(parseNumberCell("")).toEqual({ ok: true, value: null });
    for (const bad of ["abc", "1.2.3", "TBC", "1e5", "$5"]) expect(parseNumberCell(bad), bad).toEqual({ ok: false });
  });
});

describe("formatting", () => {
  it("shows money to the cent, half up, with separators", () => {
    expect(money("1226916.805")).toBe("1,226,916.81");
    expect(money("0.1")).toBe("0.10");
    expect(money("-1234.5")).toBe("-1,234.50");
    expect(money(null)).toBe("");
  });
  it("trims quantities and shows percentages", () => {
    expect(num("1000.000")).toBe("1,000");
    expect(num("0.30")).toBe("0.3");
    expect(pct("0.2273")).toBe("22.73%");
  });
});
