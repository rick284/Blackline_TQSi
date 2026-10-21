import { describe, expect, it } from "vitest";
import { submission } from "@blackline/tender/core";
import { letterDoc } from "../src/lib/letterDoc.js";

const schedule = {
  groups: [{ name: "WORKS", code: "", total: "1234.5", lines: [{ ref: "01", trade: "Earthworks", kind: "work", amount: "1000" }, { ref: "02", trade: "Margin", kind: "margin", amount: "234.5" }] }],
  total: "1234.5",
  reconciles: true,
};
const letter = submission.defaultLetter({ name: "Roads", client: "Council" });
const q = (id: string, text: string, include: boolean): submission.Qualification => ({ id, kind: "custom", ref: "", text, include });

describe("the tender letter as the client reads it", () => {
  const doc = letterDoc({
    company: "Demo Civil", today: new Date(2026, 9, 22), letter,
    qualifications: [q("Q1", "Foundations by others", true), q("Q2", "Left out", false)],
    alternatives: [
      { id: "A1", title: "Concrete paths", description: "Instead of AP40", amount: "12500.5", include: true },
      { id: "A2", title: "Drop the fence", description: "", amount: "-3000", include: true },
      { id: "A3", title: "Not offered", description: "", amount: "1", include: false },
    ],
    schedule,
  });

  it("takes the schedule as calculated, in the client's order, to the cent", () => {
    expect(doc.total).toBe("1,234.50");
    expect(doc.groups[0]!.lines.map((l) => [l.ref, l.amount])).toEqual([["01", "1,000.00"], ["02", "234.50"]]);
    expect(doc.scheduleOk).toBe(true);
  });
  it("includes only the qualifications and alternatives switched on, and marks a saving", () => {
    expect(doc.qualifications).toEqual(["Foundations by others"]);
    expect(doc.alternatives.map((a) => [a.title, a.amount, a.saving])).toEqual([["Concrete paths", "12,500.50", false], ["Drop the fence", "-3,000.00", true]]);
  });
  it("dates the letter and states how long the price is valid", () => {
    expect(doc.date).toBe("22 October 2026");
    expect(doc.validity).toBe("This tender is valid for 30 days from the date of this letter.");
  });
});
