import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMNS } from "../src/lib/ganttColumns.js";
import { defaultSettings, nextSort, parseSettings } from "../src/lib/ganttSettings.js";

describe("saved Gantt view", () => {
  it("falls back to the default for nothing, rubbish or the wrong shape", () => {
    expect(parseSettings(null)).toEqual(defaultSettings());
    expect(parseSettings("not json")).toEqual(defaultSettings());
    expect(parseSettings("42")).toEqual(defaultSettings());
    expect(parseSettings("null")).toEqual(defaultSettings());
    expect(defaultSettings().columns).toEqual(DEFAULT_COLUMNS);
  });
  it("keeps what is valid and drops what isn't, field by field", () => {
    const s = parseSettings(JSON.stringify({
      columns: ["id", "work", "bogus"], sort: { key: "finish", dir: "desc" }, filter: { kind: "late", text: "fill", resourceUid: 3, from: "2026-10-01T08:00:00" },
      zoom: "days", leftW: 5000, showCritical: false, showBaseline: "yes",
    }));
    expect(s.columns).toEqual(["id", "name", "work"]);
    expect(s.sort).toEqual({ key: "finish", dir: "desc" });
    expect(s.filter).toMatchObject({ kind: "late", text: "fill", resourceUid: 3, from: "2026-10-01T08:00:00" });
    expect([s.zoom, s.leftW, s.showCritical, s.showBaseline]).toEqual(["days", 1400, false, true]);
    const bad = parseSettings(JSON.stringify({ sort: { key: "nope", dir: "asc" }, filter: { kind: "weird", text: 5 }, zoom: "decades", leftW: "wide" }));
    expect([bad.sort, bad.filter.kind, bad.filter.text, bad.zoom, bad.leftW]).toEqual([null, "all", "", "weeks", 560]);
  });
  it("cycles a heading's sort: ascending, descending, off; a new heading starts ascending", () => {
    const a = nextSort(null, "name");
    expect(a).toEqual({ key: "name", dir: "asc" });
    const b = nextSort(a, "name");
    expect(b).toEqual({ key: "name", dir: "desc" });
    expect(nextSort(b, "name")).toBeNull();
    expect(nextSort(b, "start")).toEqual({ key: "start", dir: "asc" });
  });
});
