/**
 * The all-in package price must carry the same overhead / profit / bond / finance choices as the own-works tender (found by an
 * independent review in QSi Pro: fixed or markup choices were ignored once the package was consolidated). Small-number oracles,
 * worked by hand. Ported from QSi Pro engine/tests/test_final_price.py.
 */
import { describe, expect, it } from "vitest";
import { cents, D } from "@blackline/engine";
import {
  computeConsolidated, computeSchedule, computeTender, packageSellLine, type CommercialInput, type Overlay, type Schedule,
} from "../src/index.js";

type Basis = [method: string, include: string, pct: string, pc: string];
const s = (x: { toString(): string }) => x.toString();

function stack(oh: Basis = ["Markup %", "Yes", "0.10", "0"], pr: Basis = ["Margin %", "Yes", "0.15", "0"], bonds?: [string, string, string], fin?: [string, string, string]): CommercialInput[] {
  const out: CommercialInput[] = [
    { ref: "CA17", name: "Overhead", method: oh[0], include: oh[1], pct: oh[2], pcSum: oh[3] },
    { ref: "CA18", name: "Profit", method: pr[0], include: pr[1], pct: pr[2], pcSum: pr[3] },
  ];
  if (bonds) out.push({ ref: "CA19", name: "Bonds", method: bonds[0], include: "Yes", pct: bonds[1], pcSum: bonds[2] });
  if (fin) out.push({ ref: "CA20", name: "Retention finance", method: fin[0], include: "Yes", pct: fin[1], pcSum: fin[2] });
  return out;
}

const OVERLAYS: Overlay[] = [{ name: "Sub A", amount: 100 }];
const FIXED: [Basis, Basis] = [["Fixed Amount", "Yes", "0", "30"], ["Fixed Amount", "Yes", "0", "40"]];
const consolidated = (own: D | number, overlays: Overlay[], com: CommercialInput[]) => computeConsolidated(new D(own), overlays, 0, { commercial: com });

describe("package price carries the chosen basis", () => {
  it("does not scale or replace fixed amounts with rates", () => {
    const com = stack(...FIXED);
    const t = computeTender(new D(200), com);
    expect(s(t.tenderExclGst)).toBe("270");
    expect(s(consolidated(t.subtotal, [], com).allInTender)).toBe("270"); // review example P01: was 258.82
  });

  it("respects a profit markup basis in the all-in", () => {
    const com = stack(undefined, ["Markup %", "Yes", "0.15", "0"]);
    const t = computeTender(new D(200), com);
    expect(s(t.tenderExclGst)).toBe("253");
    expect(s(consolidated(t.subtotal, [], com).allInTender)).toBe("253"); // review example P02: was 258.82
  });

  it("carries the basis through when overlays are added", () => {
    expect(s(consolidated(200, OVERLAYS, stack(...FIXED)).allInTender)).toBe("370"); // 300 cost + 30 + 40, nothing scaled
    expect(s(consolidated(200, OVERLAYS, stack(undefined, ["Markup %", "Yes", "0.15", "0"])).allInTender)).toBe("379.5"); // 300 + 30 overhead, then 15% of 330
    expect(s(cents(consolidated(200, OVERLAYS, stack()).allInTender))).toBe(s(cents(new D(330).div("0.85")))); // unchanged Hobsonville method
    expect(s(consolidated(200, OVERLAYS, stack(["Markup %", "No", "0.10", "0"], ["Markup %", "Yes", "0.10", "0"])).allInTender)).toBe("330"); // overhead switched off
  });

  it("carries bonds and retention finance into the package", () => {
    const com = stack(undefined, ["Markup %", "Yes", "0.10", "0"], ["%", "0.02", "0"], ["PC Sum", "0", "5"]);
    const t = computeTender(new D(200), com);
    expect(t.tenderExclGst.eq(new D("1.1").times(200 + 20 + 4 + 5))).toBe(true);
    expect(consolidated(200, [], com).allInTender.eq(t.tenderExclGst)).toBe(true);
    // percentages follow the bigger base, the fixed finance sum does not
    expect(consolidated(200, OVERLAYS, com).allInTender.eq(new D("1.1").times(300 + 30 + 6 + 5))).toBe(true);
  });
});

const OH: Basis[] = [["Markup %", "Yes", "0.10", "0"], ["Fixed Amount", "Yes", "0", "30"], ["Markup %", "No", "0.10", "0"]];
const PR: Basis[] = [["Margin %", "Yes", "0.15", "0"], ["Markup %", "Yes", "0.15", "0"], ["Fixed Amount", "Yes", "0", "40"], ["Margin %", "No", "0.15", "0"]];

describe("every overhead and profit combination", () => {
  for (const oh of OH)
    for (const pr of PR)
      it(`with no overlays, the all-in equals the own-works tender (${oh[0]}/${oh[1]}, ${pr[0]}/${pr[1]})`, () => {
        const com = stack(oh, pr);
        const t = computeTender(new D(200), com);
        expect(consolidated(t.subtotal, [], com).allInTender.eq(t.tenderExclGst)).toBe(true);
      });

  for (const oh of OH.slice(0, 2))
    for (const pr of PR.slice(0, 3))
      it(`client schedule groups add up to the all-in (${oh[0]}, ${pr[0]})`, () => {
        const com = stack(oh, pr);
        const byRef = new Map(com.map((c) => [c.ref, c]));
        const cons = consolidated(200, OVERLAYS, com);
        const sched: Schedule = {
          name: "S", client: "",
          groups: [
            { id: "g1", name: "Own", code: "", lines: [{ ref: "1", trade: "Works", kind: "work" }, { ref: "2", trade: "Margin", kind: "margin" }] },
            { id: "g2", name: "Sub", code: "", lines: [{ ref: "3", trade: "Sub A", kind: "work" }, { ref: "4", trade: "Margin", kind: "margin" }] },
          ],
          map: { "qs:A": "line:1", "overlay:Sub A": "line:3" },
        };
        const r = computeSchedule(
          sched,
          [{ key: "qs:A", label: "A", amount: 200, own: true }, { key: "overlay:Sub A", label: "Sub A", amount: 100, own: false }],
          cons.allInTender,
          { line: packageSellLine(byRef) },
        );
        expect(r.reconciles, r.problems.join("; ")).toBe(true);
        const sum = r.groups.reduce((t, g) => t.plus(g.total), new D(0));
        expect(sum.minus(cents(cons.allInTender)).abs().lt("0.011")).toBe(true);
      });
});
