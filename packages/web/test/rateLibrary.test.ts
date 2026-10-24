import { describe, expect, it } from "vitest";
import { cleanRate, type CompanyRate, libraryBody, matchPicks, pickList, toCompanyInput, typeOfCategory } from "../src/lib/rateLibrary.js";
import type { LibraryRow } from "../src/lib/model.js";

const job = (code: string, description = "", o: Partial<LibraryRow> = {}) => ({ code, description, category: "", unit: "hr", baseRate: "10", ...o }) as LibraryRow;
const co = (code: string, description = "", o: Partial<CompanyRate> = {}): CompanyRate => ({ id: code, code, category: "Labour", description, unit: "hr", baseRate: "85.5", operatorIncluded: "", fuelIncluded: "", source: "", updatedAt: "", ...o });

describe("rates as typed", () => {
  it("keeps up to six places and trims trailing zeros", () => {
    expect([cleanRate("85.50"), cleanRate("$1,200"), cleanRate(""), cleanRate("0.1234567"), cleanRate(100)]).toEqual(["85.5", "1200", "0", "0.123457", "100"]);
  });
  it("refuses what is not a non-negative number", () => {
    expect([cleanRate("abc"), cleanRate("-5"), cleanRate("1e999999")]).toEqual([null, null, null]);
  });
  it("reads a category as a resource type", () => {
    expect([typeOfCategory("Labour"), typeOfCategory("plant"), typeOfCategory("Materials"), typeOfCategory("Misc")]).toEqual(["Labour", "Plant", "Material", null]);
  });
});

describe("the pick list", () => {
  const list = pickList([job("PL-EXC"), job("LAB-A")], [co("lab-a"), co("LAB-B", "Carpenter"), co("MAT-1", "Concrete", { category: "Material" })]);
  it("lists the job's own rates and only the company's that the job does not have, sorted by code", () => {
    expect(list.map((p) => [p.code, p.fromCompany])).toEqual([["LAB-A", false], ["LAB-B", true], ["MAT-1", true], ["PL-EXC", false]]);
  });
  it("narrows by code or description, codes that start with what was typed first", () => {
    expect(matchPicks(list, "").length).toBe(4);
    expect(matchPicks(list, "conc").map((p) => p.code)).toEqual(["MAT-1"]);
    expect(matchPicks(list, "a").map((p) => p.code)).toEqual(["LAB-A", "LAB-B", "PL-EXC", "MAT-1"].filter((c) => matchPicks(list, "a").some((p) => p.code === c)));
    expect(matchPicks(list, "lab").map((p) => p.code)).toEqual(["LAB-A", "LAB-B"]);
    expect(matchPicks(list, "zzz")).toEqual([]);
  });
});

describe("copies between the libraries", () => {
  it("a job takes the whole rate, nothing more", () => {
    expect(Object.keys(libraryBody(co("X", "d")))).toEqual(["code", "category", "description", "unit", "baseRate", "operatorIncluded", "fuelIncluded", "source"]);
  });
  it("leaves out a job rate that is not a plain number", () => {
    expect(toCompanyInput(job("A", "d", { baseRate: "12.50" } as Partial<LibraryRow>))?.baseRate).toBe("12.5");
    expect(toCompanyInput(job("B", "d", { baseRate: "n/a" } as Partial<LibraryRow>))).toBeNull();
  });
});
