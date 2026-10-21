import { describe, expect, it } from "vitest";
import { allocate, calculate, cents, D, type Estimate, sum } from "../src/index.js";

const est = (mode: "markup" | "margin" = "markup", pct = "8"): Estimate => ({
  resources: [
    { id: "lab", kind: "labour", unit: "hr", rate: "55" },
    { id: "exc", kind: "plant", unit: "hr", rate: "120" },
    { id: "pipe", kind: "material", unit: "m", rate: "18.40" },
    { id: "mh", kind: "material", unit: "ea", rate: "850" },
  ],
  root: {
    id: "root",
    name: "Job",
    lines: [],
    sections: [
      {
        id: "drain",
        name: "Drainage",
        sections: [],
        lines: [
          {
            id: "a",
            code: "D1",
            description: "300 dia pipe",
            quantity: "100",
            unit: "m",
            components: [
              { resourceId: "lab", qtyPerUnit: "0.5" },
              { resourceId: "exc", qtyPerUnit: "0.25" },
              { resourceId: "pipe", qtyPerUnit: "1", wastePct: "5" },
            ],
          },
          {
            id: "b",
            code: "D2",
            description: "Manholes",
            quantity: "3",
            unit: "ea",
            components: [
              { resourceId: "lab", qtyPerUnit: "4" },
              { resourceId: "mh", qtyPerUnit: "1" },
            ],
          },
        ],
      },
    ],
  },
  settings: {
    onCosts: [{ id: "lo", name: "Labour on-costs", pct: "20", appliesTo: ["labour"] }],
    overheadPct: "10",
    margin: { mode, pct },
  },
});

describe("money", () => {
  it("has no float error", () => {
    expect(new D("0.1").plus("0.2").toString()).toBe("0.3");
  });
  it("rounds half up to cents", () => {
    expect(cents("1.005").toString()).toBe("1.01");
    expect(cents("2.004").toString()).toBe("2");
  });
  it("allocates to the cent with no drift", () => {
    const parts = allocate(new D("100"), [new D(1), new D(1), new D(1)]);
    expect(parts.map(String)).toEqual(["33.34", "33.33", "33.33"]);
    expect(sum(parts).toString()).toBe("100");
  });
});

describe("calculate", () => {
  it("prices lines by kind", () => {
    const r = calculate(est());
    const a = r.lines.get("a")!;
    expect(a.byKind.labour.toString()).toBe("2750");
    expect(a.byKind.plant.toString()).toBe("3000");
    expect(a.byKind.material.toString()).toBe("1932");
    expect(a.directCost.toString()).toBe("7682");
    expect(a.labourHours.toString()).toBe("50");
    expect(r.lines.get("b")!.directCost.toString()).toBe("3210");
  });

  it("builds up the summary to the cent (markup)", () => {
    const s = calculate(est()).summary;
    expect(s.directCost.toString()).toBe("10892");
    expect(s.onCosts[0]!.amount.toString()).toBe("682");
    expect(s.overhead.toString()).toBe("1157.4");
    expect(s.totalCost.toString()).toBe("12731.4");
    expect(s.margin.toString()).toBe("1018.51");
    expect(s.sell.toString()).toBe("13749.91");
    expect(s.labourHours.toString()).toBe("62");
  });

  it("supports margin on sell", () => {
    const s = calculate(est("margin", "15")).summary;
    expect(s.sell.toString()).toBe("14978.12");
  });

  it("reconciles line sell and section totals to the estimate", () => {
    const r = calculate(est());
    const lineSell = sum([...r.lines.values()].map((l) => l.sell));
    expect(lineSell.toString()).toBe(r.summary.sell.toString());
    const root = r.sections.get("root")!;
    expect(root.directCost.toString()).toBe(r.summary.directCost.toString());
    expect(root.sell.toString()).toBe(r.summary.sell.toString());
    expect(r.sections.get("drain")!.labourHours.toString()).toBe("62");
  });

  it("rejects an unknown resource", () => {
    const e = est();
    e.root.sections[0]!.lines[0]!.components[0]!.resourceId = "nope";
    expect(() => calculate(e)).toThrow(/unknown resource/);
  });
});
