import { describe, expect, it } from "vitest";
import { editRecord, effectiveRecords, type Drafts, type ServerRecord } from "../src/lib/draft.js";
import { empty, record, redo, undo } from "../src/lib/history.js";

describe("undo and redo", () => {
  it("steps back and forward through changes in order", () => {
    let h = empty<string>();
    h = record(h, "a"); // a -> b
    h = record(h, "b"); // b -> c
    const u1 = undo(h, "c")!;
    expect(u1.value).toBe("b");
    const u2 = undo(u1.history, u1.value)!;
    expect(u2.value).toBe("a");
    expect(undo(u2.history, u2.value)).toBeNull();
    const r1 = redo(u2.history, u2.value)!;
    expect(r1.value).toBe("b");
    expect(redo(r1.history, r1.value)!.value).toBe("c");
  });

  it("forgets what could be redone once something new is changed", () => {
    let h = record(record(empty<string>(), "a"), "b");
    const u = undo(h, "c")!;
    h = record(u.history, "b"); // b -> d
    expect(h.future).toEqual([]);
    expect(redo(h, "d")).toBeNull();
  });

  it("keeps only the latest steps", () => {
    let h = empty<number>();
    for (let i = 0; i < 10; i++) h = record(h, i, 4);
    expect(h.past).toEqual([6, 7, 8, 9]);
  });

  it("puts a whole draft back, including an added or deleted record", () => {
    const server: ServerRecord[] = [{ id: "library:LAB", packageId: "p", data: { kind: "library", seq: 1, body: { code: "LAB", baseRate: "50" } } }];
    const d0: Drafts = {};
    const d1 = editRecord(d0, server, "p", "library:LAB", (b) => ({ ...b, baseRate: "60" }));
    let h = record(empty<Drafts>(), d0);
    expect(effectiveRecords(server, d1)[0]!.data.body).toMatchObject({ baseRate: "60" });
    const u = undo(h, d1)!;
    expect(effectiveRecords(server, u.value)[0]!.data.body).toMatchObject({ baseRate: "50" });
    expect(Object.keys(u.value)).toEqual([]); // back to no changes at all
    h = u.history;
    expect(effectiveRecords(server, redo(h, u.value)!.value)[0]!.data.body).toMatchObject({ baseRate: "60" });
  });
});
