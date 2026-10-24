import { describe, expect, it } from "vitest";
import { copyName, nameFromFile, type RegisterJob, summarise, visible } from "../src/lib/register.js";

const job = (o: Partial<RegisterJob>): RegisterJob => ({
  id: "x", name: "J", client: "", status: "enquiry", created_at: "2026-10-01T00:00:00Z", contact_id: null, due_at: null, owner_id: null, owner_name: null,
  notes: "", approx_value: "", decision_reason: "", decided_at: null, archived_at: null, ...o,
});

const jobs = [
  job({ id: "1", name: "Hobsonville Road", client: "TPW", status: "tender", approx_value: "1200000.50", created_at: "2026-10-03T00:00:00Z" }),
  job({ id: "2", name: "Eastglen Road", client: "Aurecon", status: "enquiry", approx_value: "300000", created_at: "2026-10-02T00:00:00Z" }),
  job({ id: "3", name: "Old culvert", status: "awarded", created_at: "2026-09-01T00:00:00Z" }),
  job({ id: "4", name: "Lost one", status: "lost", archived_at: "2026-10-05T00:00:00Z" }),
  job({ id: "5", name: "Issued one", status: "issued", owner_name: "Maya" }),
];

describe("the register's views", () => {
  it("shows the chosen view, newest first, and keeps archived jobs out of everything but Archived", () => {
    expect(visible(jobs, "open", "").map((j) => j.id)).toEqual(["1", "2"]);
    expect(visible(jobs, "all", "").map((j) => j.id)).toEqual(["1", "2", "5", "3"]);
    expect(visible(jobs, "archived", "").map((j) => j.id)).toEqual(["4"]);
    expect(visible(jobs, "closed", "")).toEqual([]);
  });
  it("narrows by name, client, owner or notes without regard to capitals", () => {
    expect(visible(jobs, "all", "tpw").map((j) => j.id)).toEqual(["1"]);
    expect(visible(jobs, "all", "  maya ").map((j) => j.id)).toEqual(["5"]);
    expect(visible(jobs, "all", "culvert").map((j) => j.id)).toEqual(["3"]);
  });
});

describe("the totals", () => {
  it("counts by stage and adds up the open pipeline exactly", () => {
    const s = summarise(jobs);
    expect(s).toMatchObject({ open: 2, issued: 1, awarded: 1, closed: 0, archived: 1, pipeline: "1500000.5" });
  });
  it("ignores values that are not plain numbers", () => {
    expect(summarise([job({ approx_value: "about 2m", status: "tender" })]).pipeline).toBe("0");
  });
});

describe("names", () => {
  it("gives a copy the first free name", () => {
    expect(copyName("Job", ["Job"])).toBe("Job (copy)");
    expect(copyName("Job", ["Job", "job (copy)"])).toBe("Job (copy 2)");
    expect(copyName("Job (copy)", ["Job", "Job (copy)"])).toBe("Job (copy 2)");
  });
  it("makes a job name from a file name", () => {
    expect(nameFromFile("01_329_Hobsonville_Road_Estimate_Rev34E.xlsx")).toBe("01 329 Hobsonville Road Estimate Rev34E");
  });
});
