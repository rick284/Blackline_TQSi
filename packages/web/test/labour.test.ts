import { describe, expect, it } from "vitest";
import { buildModel } from "../src/lib/model.js";
import { effectiveRecords, setRecord, type ServerRecord } from "../src/lib/draft.js";
import { splitIntoPackages, type TenderInputs } from "@blackline/tender/core";
import { buildRecords, canBuild, formFromBuild, inputsOf, newForm, preview, type LabourForm } from "../src/lib/labour.js";

const filled = (over: Partial<LabourForm> = {}): LabourForm => ({ ...newForm("2026-10-01", "LAB-CARP"), role: "Carpenter", hourly_rate: "40", productive_hours_week: "36", levy_pct: "2", ...over });

describe("labour builder", () => {
  it("turns typed percentages into fractions and back", () => {
    const f = filled();
    const i = inputsOf(f);
    expect(i.kiwisaver_pct).toBe("0.03");
    expect(i.levy_pct).toBe("0.02");
    expect(formFromBuild("LAB-CARP", i as any).kiwisaver_pct).toBe("3");
    expect(formFromBuild("LAB-CARP", i as any).levy_pct).toBe("2");
  });

  it("builds the rate from the policy steps, as the engine does", () => {
    const p = preview(filled());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    // weekly pay 1600; KiwiSaver 48; leave 36 days / 5 = 7.2 weeks off of 44.93 worked; levies 2% of the running total
    expect(p.result.steps[0]!.amount.toString()).toBe("1600");
    expect(p.result.steps[1]!.amount.toString()).toBe("48");
    expect(p.result.status).toBe("AMBER");
    expect(Number(p.result.rateRounded)).toBeGreaterThan(40 * 40 / 36);
  });

  it("says what is wrong instead of failing", () => {
    expect(preview(filled({ hourly_rate: "" }))).toMatchObject({ ok: false });
    expect(preview(filled({ productive_hours_week: "" }))).toMatchObject({ ok: false });
    expect(preview(filled({ productive_hours_week: "41" }))).toMatchObject({ ok: false, error: expect.stringContaining("Productive hours") });
    expect(preview(filled({ hourly_rate: "abc" }))).toMatchObject({ ok: false });
    expect(preview(filled({ role: "" }))).toMatchObject({ ok: false, error: expect.stringContaining("role") });
  });

  it("is RED for a raw wage, GREEN only for company actuals with an independent check", () => {
    const status = (f: LabourForm) => { const p = preview(f); return p.ok ? p.result.status : "ERR"; };
    expect(status(filled({ evidence: "raw wage" }))).toBe("RED");
    expect(status(filled({ evidence: "company actual" }))).toBe("AMBER");
    expect(status(filled({ evidence: "company actual", independent_check: true }))).toBe("GREEN");
  });

  it("never overwrites a rate that was typed in by hand", () => {
    expect(canBuild("LAB-NEW", false, false)).toEqual({ ok: true });
    expect(canBuild("LAB-FOREMAN", true, false)).toMatchObject({ ok: false });
    expect(canBuild("LAB-CARP", true, true)).toEqual({ ok: true });
    expect(canBuild("bad code!", false, false)).toMatchObject({ ok: false });
  });

  it("writes the library rate and the build, and keeps a note of an earlier build", () => {
    const first = buildRecords("LAB-CARP", filled(), {}, 5);
    expect(first.library.body).toMatchObject({ code: "LAB-CARP", category: "Labour", unit: "hr" });
    expect((first.library.body as any).description).toContain("Carpenter");
    expect((first.library.body as any).source).toContain("AMBER");
    expect((first.build.body as any).history).toEqual([]);

    const second = buildRecords("LAB-CARP", filled({ hourly_rate: "45" }), { library: first.library, build: first.build.body as any }, 9);
    expect(second.library.seq).toBe(first.library.seq); // the rate keeps its place in the library
    const h = (second.build.body as any).history;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ rate: (first.library.body as any).baseRate, status: "AMBER", evidence: "market normalised" });
    expect(Number((second.library.body as any).baseRate)).toBeGreaterThan(Number((first.library.body as any).baseRate));
  });

  it("reprices the estimate when a built rate is saved into a draft", () => {
    const inputs: TenderInputs = {
      library: [{ code: "LAB-CARP", category: "Labour", description: "x", unit: "hr", baseRate: "50" }],
      qs: [{ code: "EW01", section: "Earthworks", description: "Strip", unit: "m2", quantity: "100" }],
      rows: [{ qsCode: "EW01", mode: "Direct Qty", resourceType: "Labour", resourceCode: "LAB-CARP", manualQty: "10", verified: "Yes", uid: "EW01-001" }],
      weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
      tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
      commercial: [], overlays: [], overlap: "0", reference: null,
    };
    // the library rate here is typed in by hand: building over it is refused, so the build goes to a new code
    expect(canBuild("LAB-CARP", true, false).ok).toBe(false);
    const server: ServerRecord[] = splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}`, data: JSON.parse(JSON.stringify(data)) })));
    const libPkg = server.find((r) => r.id === "library:LAB-CARP")!.packageId;
    const made = buildRecords("LAB-NEW", filled({ code: "LAB-NEW" }), {}, 2);
    let d = setRecord({}, server, libPkg, "library:LAB-NEW", made.library);
    d = setRecord(d, server, libPkg, "labour:LAB-NEW", made.build);
    const m = buildModel(effectiveRecords(server, d));
    const row = m.library.find((r) => r.code === "LAB-NEW")!;
    expect([row.built, row.packageId]).toEqual([true, libPkg]);
    expect(m.library.find((r) => r.code === "LAB-CARP")!.built).toBe(false);
    expect(m.labourBuilds["LAB-NEW"]).toBeDefined();
    expect(row.baseRate).toBe((made.library.body as any).baseRate);
  });
});
