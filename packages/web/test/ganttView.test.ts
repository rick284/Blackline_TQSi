import { describe, expect, it } from "vitest";
import { gantt as G } from "@blackline/tender/core";
import { makeScale, nonWorking, tOf, tiers, visibleRows, xOf, zoomIn, zoomOut } from "../src/lib/ganttView.js";

const T = (s: string) => G.toMin(s);

describe("timescale", () => {
  it("starts on a Monday for days and weeks, a month start for months, a quarter start for quarters", () => {
    const first = T("2026-10-14T08:00:00"), last = T("2026-12-01T17:00:00");
    expect(G.fromMin(makeScale("days", first, last).startMin).slice(0, 10)).toBe("2026-10-05"); // 3 days' margin, then back to Monday
    expect(G.fromMin(makeScale("weeks", first, last).startMin).slice(0, 10)).toBe("2026-09-28");
    expect(G.fromMin(makeScale("months", first, last).startMin).slice(0, 10)).toBe("2026-09-01");
    expect(G.fromMin(makeScale("quarters", first, last).startMin).slice(0, 10)).toBe("2026-07-01");
  });
  it("maps a moment to a position and back", () => {
    const s = makeScale("days", T("2026-10-05T08:00:00"), T("2026-10-30T17:00:00"));
    const t = T("2026-10-12T10:30:00");
    expect(tOf(s, xOf(s, t))).toBeCloseTo(t, 6);
    expect(xOf(s, t + 1440) - xOf(s, t)).toBeCloseTo(32, 6); // a day is 32 px at day zoom
    expect(s.width).toBeGreaterThan(xOf(s, T("2026-10-30T17:00:00")));
  });
  it("fills a minimum width", () => {
    expect(makeScale("quarters", T("2026-10-05T08:00:00"), T("2026-10-06T08:00:00"), 1500).width).toBeGreaterThanOrEqual(1500);
  });
  it("steps through the zooms and stops at the ends", () => {
    expect(zoomIn("quarters")).toBe("months");
    expect(zoomIn("days")).toBe("days");
    expect(zoomOut("months")).toBe("quarters");
    expect(zoomOut("quarters")).toBe("quarters");
  });
  it("labels two tiers: weeks over days, months over weeks, years over months, years over quarters", () => {
    const first = T("2026-10-05T08:00:00"), last = T("2026-11-20T17:00:00");
    const d = tiers(makeScale("days", first, last));
    expect(d.top[0]!.label).toMatch(/^\d{1,2} \w{3} 26$/);
    expect(d.bottom.slice(0, 7).map((t) => t.label)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    expect(d.bottom.every((t) => Math.abs(t.w - 32) < 0.001)).toBe(true);
    const w = tiers(makeScale("weeks", first, last));
    expect(w.top.map((t) => t.label)).toContain("Oct 2026");
    expect(w.top.map((t) => t.label)).toContain("Nov 2026");
    const m = tiers(makeScale("months", first, last));
    expect(m.top[0]!.label).toBe("2026");
    expect(m.bottom.map((t) => t.label)).toContain("Oct");
    const q = tiers(makeScale("quarters", first, last));
    expect(q.bottom.map((t) => t.label)).toContain("Q4");
    for (const t of [...d.top, ...d.bottom, ...w.top, ...m.top, ...q.bottom]) expect(t.x).toBeGreaterThanOrEqual(0);
  });
});

describe("non-working time", () => {
  it("shades weekends and holidays, merged, only when days are wide enough to see", () => {
    const cal = G.standardCalendar();
    cal.exceptions.push({ name: "Labour Day", from: "2026-10-26", to: "2026-10-26", working: false, times: [] });
    const s = makeScale("days", T("2026-10-19T08:00:00"), T("2026-10-30T17:00:00"));
    const nw = nonWorking(cal, s);
    // Sat 24 + Sun 25 + Mon 26 are one block of three days
    const block = nw.find((r) => Math.abs(r.x - xOf(s, T("2026-10-24T00:00:00"))) < 0.01)!;
    expect(block.w).toBeCloseTo(3 * 32, 6);
    expect(nonWorking(cal, makeScale("months", T("2026-10-19T08:00:00"), T("2026-10-30T17:00:00")))).toEqual([]);
  });
});

describe("collapsing", () => {
  const r = (n: number[]) => n.map((outline, i) => ({ task: { uid: i + 1, outline } }));
  it("hides what is inside a collapsed summary, and nothing else", () => {
    const rows = r([1, 2, 3, 2, 1, 2]);
    expect(visibleRows(rows, new Set()).map((x) => x.task.uid)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(visibleRows(rows, new Set([1])).map((x) => x.task.uid)).toEqual([1, 5, 6]);
    expect(visibleRows(rows, new Set([2])).map((x) => x.task.uid)).toEqual([1, 2, 4, 5, 6]);
    expect(visibleRows(rows, new Set([1, 2])).map((x) => x.task.uid)).toEqual([1, 5, 6]);
    expect(visibleRows(rows, new Set([5])).map((x) => x.task.uid)).toEqual([1, 2, 3, 4, 5]);
  });
});
