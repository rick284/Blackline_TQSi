/** Weather tool vs NZ_Weather_Risk_Estimating_Tool_Rev2.xlsx (QSi Pro golden scenarios, recalculated in LibreOffice). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D } from "@blackline/engine";
import { runTool, stations, taskNames, toolData, weatherSetup, type OverrideField, type WeatherActivity } from "../src/index.js";

interface Scenario {
  station: string;
  working_days_per_week: number;
  local_factor: string;
  wind_override: string | null;
  daily_prelims: string;
  weekly_hire: string;
  recovery: string;
  activities: { task: string; start: string; finish: string; critical: boolean; labour: string; plant: string; overrides: Record<string, string> }[];
  expected: {
    activities: Record<string, any>[];
    exposed_pool: number; total: number | string; direct: number; cp_delay_wd: number; weeks: number; prelims: number; hire: number;
  };
}

const GOLD: Scenario[] = JSON.parse(readFileSync(new URL("./fixtures/golden_weather_rev2.json", import.meta.url), "utf8")).scenarios;
const TOL = 1e-6;
const close = (a: { toString(): string }, b: unknown, msg = "") => expect(Math.abs(Number(a.toString()) - Number(b)), `${msg}: ${a} vs ${b}`).toBeLessThan(TOL);

const run = (sc: Scenario, includeWind = true) =>
  runTool(
    { station: sc.station, workingDaysPerWeek: sc.working_days_per_week, localFactor: sc.local_factor, windOverride: sc.wind_override, dailyPrelims: sc.daily_prelims, weeklyHire: sc.weekly_hire, recovery: sc.recovery },
    sc.activities.map((a) => ({ ...a, overrides: a.overrides as WeatherActivity["overrides"] })),
    includeWind,
  );

describe("matches the real tool workbook", () => {
  GOLD.forEach((sc, i) => {
    it(`scenario ${i}`, () => {
      const exp = sc.expected;
      const r = run(sc);
      sc.activities.forEach((act, j) => {
        const a = r.activities[j]!, e = exp.activities[j]!;
        expect(a.workdays).toBe(e.workdays);
        if (a.workdays === 0) {
          // the workbook leaves the row blank; the platform flags it RED
          expect(e.wet_probability).toBeNull();
          expect(a.status).toBe("RED - date input");
          return;
        }
        close(a.wetProbability, e.wet_probability, `${i} ${a.task} wet`);
        close(a.adjustedWetProbability, e.adjusted_wet_probability, "adj");
        close(a.windProbability, e.wind_probability, "wind");
        close(a.rainImpact, e.rain_impact, "rain");
        close(a.carryoverImpact, e.carryover_impact, "carry");
        close(a.windImpact, e.wind_impact, "windImpact");
        close(a.combinedImpact, e.combined_impact, "combined");
        close(a.directAllowance, e.direct_allowance, "direct");
        close(a.lostWd, e.lost_wd, "lostWd");
        const task = toolData().tasks.find((t) => t.name === a.task)!;
        const numericWind = a.status === "RED - wind input" || "wind_sensitivity" in act.overrides || new D(task.wind_sensitivity).gte("0.2");
        if (numericWind || e.status !== "RED - wind input") expect(a.status, a.task).toBe(e.status);
        else {
          // Known workbook quirk: task factors are stored as TEXT, which Excel treats as greater than any number, so the workbook
          // flags every task at a station with no wind data as RED. The platform applies the intended rule (RED only at 20%+).
          expect(a.windProbability.isZero()).toBe(true);
          expect(a.status.startsWith("AMBER")).toBe(true);
        }
      });
      close(r.exposedPool, exp.exposed_pool, "pool");
      if (exp.total === "#VALUE!") {
        // an activity with no working days breaks the workbook's totals; total the valid rows instead
        const ok = exp.activities.filter((e) => e.workdays);
        close(r.directAllowance, ok.reduce((t, e) => t + Number(e.direct_allowance), 0), "direct (valid rows)");
        close(r.criticalPathDelayWd, ok.reduce((t, e) => t + Number(e.cp_delay_wd), 0), "delay (valid rows)");
        return;
      }
      close(r.directAllowance, exp.direct, "direct total");
      close(r.criticalPathDelayWd, exp.cp_delay_wd, "delay");
      expect(r.additionalBilledWeeks).toBe(exp.weeks);
      close(r.preliminariesAllowance, exp.prelims, "prelims");
      close(r.hireAllowance, exp.hire, "hire");
      close(r.totalAllowance, exp.total, "total");
    });
  });
});

describe("weather tool behaviour", () => {
  it("removing wind removes only the wind term", () => {
    const sc = GOLD.find((x) => x.station === "Auckland" && x.wind_override === null)!;
    const w = run(sc, true), x = run(sc, false);
    expect(x.windSensitivity.eq(w.windSensitivity) && w.windSensitivity.gt(0)).toBe(true);
    expect(x.directAllowance.plus(x.windSensitivity).eq(w.directAllowance)).toBe(true);
    expect(x.criticalPathDelayWd.lte(w.criticalPathDelayWd)).toBe(true);
  });

  it("carries a complete data set", () => {
    const d = toolData();
    expect(stations().length).toBe(30);
    expect(taskNames().length).toBe(39);
    expect(d.engine_from).toBe("2025-01-01");
    expect(Object.values(d.climate).every((v) => v.length === 12)).toBe(true);
  });

  it("validates its input", () => {
    const day = "2026-10-01";
    expect(() => runTool({ station: "Auckland" }, [{ task: "Not a task", start: day, finish: day }])).toThrow();
    expect(() => runTool({ station: "Atlantis" }, [{ task: "Bulk earthworks", start: day, finish: day }])).toThrow();
    const out = runTool({ station: "Auckland" }, [{ task: "Bulk earthworks", start: "2045-01-01", finish: "2045-02-01", critical: true, labour: 100, plant: 0 }]);
    expect(out.activities[0]!.status).toBe("RED - date input");
    expect(out.redFlags.length).toBeGreaterThan(0);
    expect(out.confidence.startsWith("RED")).toBe(true);
    const sat = "2026-10-03"; // a Saturday: no working days in the window
    expect(runTool({ station: "Auckland" }, [{ task: "Bulk earthworks", start: sat, finish: sat, critical: true, labour: 100, plant: 0 }]).activities[0]!.status).toBe("RED - date input");
    expect(runTool({ station: "Auckland" }, []).confidence.startsWith("INCOMPLETE")).toBe(true);
  });

  it("flags a wind-sensitive task at a station with no wind data as RED", () => {
    const r = runTool({ station: "Christchurch" }, [{ task: "Roofing", start: "2026-10-01", finish: "2026-10-31", critical: true, labour: 1000, plant: 0 }]);
    expect(r.activities[0]!.status).toBe("RED - wind input");
    expect(r.redFlags.length).toBeGreaterThan(0);
  });

  it("reproduces a real Hobsonville drainage run (Auckland, 1 Oct 2026, wind excluded)", () => {
    const r = runTool(
      { station: "Auckland", workingDaysPerWeek: 5, localFactor: 1, dailyPrelims: 0, weeklyHire: 0, recovery: 0 },
      [
        { task: "Drainage trenching", start: "2026-10-01", finish: "2026-10-21", critical: true, labour: "28002.59", plant: 0 },
        { task: "Drainage trenching", start: "2026-10-27", finish: "2026-11-24", critical: true, labour: "42204.30", plant: 0 },
      ],
      false,
    );
    expect(Math.abs(Number(r.directAllowance.toString()) - 14761.16708)).toBeLessThan(0.001);
    expect(Math.abs(Number(r.windSensitivity.toString()) - 797.8448)).toBeLessThan(0.01);
    expect(r.additionalBilledWeeks).toBe(2);
    expect(Math.abs(Number(r.criticalPathDelayWd.toString()) - 7.5885)).toBeLessThan(0.001);
  });
});

describe("weather setup", () => {
  it("validates setup and activity fields", () => {
    const s = weatherSetup.newSetup("Auckland", "2026-10-01", 5, 55);
    expect([s.station, s.start, s.baseline_wd, s.local_factor]).toEqual(["Auckland", "2026-10-01", 55, "1"]);
    expect(() => weatherSetup.setSetupField(s, "station", "Atlantis")).toThrow(weatherSetup.SetupError);
    expect(() => weatherSetup.setSetupField(s, "start", "2050-01-01")).toThrow(/must be between/);
    expect(() => weatherSetup.setSetupField(s, "working_days_per_week", 9)).toThrow(weatherSetup.SetupError);
    const a = weatherSetup.buildActivity("W-test0001", { task: "Bulk earthworks", start: "2026-10-01", finish: "2026-10-21", critical: "yes", qs_codes: "ew03, ew04", ov_rain_loss: "0.3" });
    expect(a.critical).toBe(true);
    expect(a.qs_codes).toEqual(["EW03", "EW04"]);
    expect(a.overrides).toEqual({ rain_loss: "0.3" });
    expect(() => weatherSetup.buildActivity("W-test0002", { task: "Bulk earthworks", start: "2026-10-21", finish: "2026-10-01" })).toThrow(/can't finish before/);
  });

  it("takes exposed cost from the weather-exposed build-up rows unless typed in", () => {
    const s = weatherSetup.newSetup("Auckland", "2026-10-01");
    s.activities.push(weatherSetup.buildActivity("W-a0000001", { task: "Bulk earthworks", start: "2026-10-01", finish: "2026-10-21", critical: true, qs_codes: "EW03" }));
    const exposed = new Map<string, [D, D]>([["EW03", [new D(1000), new D(2000)]], ["EW99", [new D(500), new D(0)]]]);
    const { result, used, warnings } = weatherSetup.runSetup(s, exposed, new D(584), new D(295), new D(0));
    expect(used[0]!.labour.toString()).toBe("1000");
    expect(used[0]!.plant.toString()).toBe("2000");
    expect(result.exposedPool.toString()).toBe("3000");
    expect(warnings.some((w) => w.includes("$500.00") && w.includes("not linked"))).toBe(true);
  });
});
