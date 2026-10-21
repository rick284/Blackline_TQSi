import { describe, expect, it } from "vitest";
import { splitIntoPackages, type TenderInputs } from "@blackline/tender/core";
import { addRecord, editRecord, effectiveRecords, type ServerRecord } from "../src/lib/draft.js";
import { buildModel } from "../src/lib/model.js";
import { addReference, newScopeItem, nextScopeId, setScopeField } from "../src/lib/scope.js";

const tiny: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [], overlays: [], overlap: "0", reference: null,
  register: [{ id: "R-EX-01", kind: "exclusion", ref: "EX-01", title: "Foundations by others", detail: "", action: "", status: "", rag: "", owner: "", likelihood: "", impact: "", rating: "" }],
  quotes: [{ id: "Q-01", ref: "Q-01", package: "Pavement", supplier: "Formcon", estimate_ref: "PV01", qty: "", unit: "", amount: "4000", scope: "", documents: "", status: "", action: "", notes: "", treatment: "", verification: "", source: "", quote_date: "", valid_until: "" }],
};

const asServer = (inputs: TenderInputs): ServerRecord[] =>
  splitIntoPackages(inputs).flatMap((p, i) => Object.entries(p.records).map(([id, data]) => ({ id, packageId: `pkg-${i}-${p.key}`, data: JSON.parse(JSON.stringify(data)) })));

describe("scope register edits", () => {
  const item = (title = "Bulk earthworks") => {
    const r = newScopeItem(title, [], [], 1);
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it("starts a new item from its requirement, with the next free reference", () => {
    const a = item();
    expect(a.recordId).toBe("scope:S1");
    expect(a.data.body).toMatchObject({ id: "S1", ref: "SC-001", title: "Bulk earthworks", owner: "", treatment: "" });
    const b = newScopeItem("Traffic management", [a.data.body as any], ["S1"], 2);
    expect(b.ok && b.data.body).toMatchObject({ id: "S2", ref: "SC-002" });
    expect(nextScopeId(["S1", "S3"])).toBe("S2");
    expect(newScopeItem("  ", [], [], 1)).toMatchObject({ ok: false });
  });

  it("matches owners and treatments to their lists and says what is wrong otherwise", () => {
    const body = item().data.body as any;
    expect(setScopeField(body, "owner", "own works")).toMatchObject({ ok: true, body: { owner: "OWN WORKS" } });
    expect(setScopeField(body, "treatment", "priced")).toMatchObject({ ok: true, body: { treatment: "PRICED" } });
    expect(setScopeField(body, "owner", "the neighbour")).toMatchObject({ ok: false, error: expect.stringContaining("Owner must be one of") });
    expect(setScopeField(body, "group", "permanent works")).toMatchObject({ ok: true, body: { group: "Permanent works" } });
    expect(setScopeField(body, "cost_refs", "ew01, pv01 EW01")).toMatchObject({ ok: true, body: { cost_refs: "EW01, PV01" } });
    expect(body.owner).toBe(""); // the original is not touched
  });

  it("adds a reference once", () => {
    let body = item().data.body as any;
    for (const ref of ["EX-01", "ex-01", "A1"]) { const r = addReference(body, "register_refs", ref); expect(r.ok).toBe(true); if (r.ok) body = r.body; }
    expect(body.register_refs).toBe("EX-01, A1");
  });

  it("moves the scope gate as items get an owner, a treatment and backing", () => {
    const server = asServer(tiny);
    const narrative = server.find((r) => r.id === "register:R-EX-01")!.packageId;
    expect(buildModel(effectiveRecords(server, {})).estimate.scope.gate).toMatch(/^NOT STARTED/);

    const made = item("Bulk earthworks");
    let drafts = addRecord({}, narrative, made.recordId, made.data);
    let m = buildModel(effectiveRecords(server, drafts));
    expect(m.estimate.scope.items[0]).toMatchObject({ ref: "SC-001", status: "MISSING" });
    expect(m.estimate.scope.gate).toMatch(/^HOLD/);
    expect(m.estimate.scope.unhomedQs).toEqual(["EW01", "PV01"]); // priced, but no scope item points at them

    const edit = (field: string, value: string) => {
      drafts = editRecord(drafts, server, narrative, made.recordId, (b) => { const r = setScopeField(b, field, value); if (!r.ok) throw new Error(r.error); return r.body; });
    };
    edit("owner", "OWN WORKS"); edit("treatment", "PRICED"); edit("cost_refs", "EW01, PV01");
    m = buildModel(effectiveRecords(server, drafts));
    expect(m.estimate.scope.items[0]).toMatchObject({ status: "COMPLETE", problems: [] });
    expect(m.estimate.scope.gate).toMatch(/^PASS/);

    edit("owner", "SUBCONTRACT"); // a subcontract item wants a quote behind it
    m = buildModel(effectiveRecords(server, drafts));
    expect(m.estimate.scope.items[0]!.problems).toEqual(["Subcontract work with no quote linked."]);
    expect(m.estimate.scope.gate).toMatch(/^REVIEW/);
    edit("quote_refs", "Q-01");
    expect(buildModel(effectiveRecords(server, drafts)).estimate.scope.items[0]!.status).toBe("COMPLETE");
  });
});
