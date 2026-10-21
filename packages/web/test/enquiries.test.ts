import { describe, expect, it } from "vitest";
import { type Action, none, record, stepBack, stepForward } from "../src/lib/actionHistory.js";
import { arrange, type ContactRow, daysToGo, dueText, type EnquiryJob, filterContacts, pipeline, whyNotGo } from "../src/lib/enquiries.js";

const job = (o: Partial<EnquiryJob>): EnquiryJob => ({
  id: "x", name: "J", client: "", status: "enquiry", created_at: "2026-10-01T00:00:00Z", contact_id: null, due_at: null, owner_id: null, owner_name: null,
  notes: "", approx_value: "", decision_reason: "", decided_at: null, ...o,
});

describe("deadlines are calendar dates", () => {
  const now = new Date(2026, 9, 22, 23, 30); // late evening, local time
  it("counts whole days whatever the time of day, and reads the same date in any time zone", () => {
    expect(daysToGo("2026-10-22T00:00:00.000Z", now)).toBe(0);
    expect(daysToGo("2026-10-27T00:00:00.000Z", now)).toBe(5);
    expect(daysToGo("2026-10-20T00:00:00.000Z", now)).toBe(-2);
    expect(daysToGo(null, now)).toBeNull();
  });
  it("says it in words", () => {
    expect(["2026-10-22", "2026-10-23", "2026-10-27", "2026-10-21", "2026-10-19"].map((d) => dueText(`${d}T00:00:00.000Z`, now)))
      .toEqual(["Due today", "Due tomorrow", "5 days to go", "1 day overdue", "3 days overdue"]);
    expect(dueText(null, now)).toBe("");
  });
});

describe("the register", () => {
  const jobs = [
    job({ id: "late", due_at: "2026-12-01T00:00:00Z" }),
    job({ id: "soon", due_at: "2026-11-01T00:00:00Z", status: "tender" }),
    job({ id: "undated", created_at: "2026-10-15T00:00:00Z" }),
    job({ id: "nb", status: "no-bid", created_at: "2026-10-20T00:00:00Z" }),
    job({ id: "iss", status: "issued", created_at: "2026-09-01T00:00:00Z" }),
  ];
  it("puts open work by deadline, soonest first and undated last, and filters by stage", () => {
    expect(arrange(jobs, "open").map((j) => j.id)).toEqual(["soon", "late", "undated"]);
    expect(arrange(jobs, "all").map((j) => j.id)).toEqual(["soon", "late", "undated", "nb", "iss"]);
    expect(arrange(jobs, "closed").map((j) => j.id)).toEqual(["nb"]);
    expect(arrange(jobs, "issued").map((j) => j.id)).toEqual(["iss"]);
  });
  it("counts the pipeline", () => {
    expect(pipeline(jobs)).toMatchObject({ enquiry: 2, tender: 1, issued: 1, "no-bid": 1, lost: 0 });
  });
  it("says what is missing before an enquiry can go to tender", () => {
    expect(whyNotGo({ owner_id: null, due_at: null })).toContain("owns it and when");
    expect(whyNotGo({ owner_id: "u", due_at: null })).toContain("when it is due");
    expect(whyNotGo({ owner_id: null, due_at: "2026-11-01T00:00:00Z" })).toContain("who owns");
    expect(whyNotGo({ owner_id: "u", due_at: "2026-11-01T00:00:00Z" })).toBeNull();
  });
});

describe("contacts", () => {
  const c = (o: Partial<ContactRow>): ContactRow => ({ id: "c", name: "", kind: "client", person: "", phone: "", email: "", trade: "", notes: "", archived_at: null, jobs: 0, ...o });
  const list = [c({ name: "TPW", person: "Dave" }), c({ name: "Allied", kind: "subcontractor", trade: "Drainage", phone: "021 555" })];
  it("search across the fields and filter by kind", () => {
    expect(filterContacts(list, "all", "drain").map((x) => x.name)).toEqual(["Allied"]);
    expect(filterContacts(list, "all", "dave").map((x) => x.name)).toEqual(["TPW"]);
    expect(filterContacts(list, "client", "").map((x) => x.name)).toEqual(["TPW"]);
    expect(filterContacts(list, "all", "021").map((x) => x.name)).toEqual(["Allied"]);
  });
});

describe("undo and redo of saved edits", () => {
  const log: string[] = [];
  const act = (label: string, fail = false): Action => ({ label, undo: async () => { if (fail) throw new Error("offline"); log.push(`undo ${label}`); }, redo: async () => { log.push(`redo ${label}`); } });
  it("runs the reverse and the repeat in order, and stays put if a save fails", async () => {
    let h = record(record(none(), act("a")), act("b"));
    const back = (await stepBack(h))!;
    expect(back.label).toBe("b");
    h = back.history;
    expect((await stepForward(h))!.label).toBe("b");
    expect(log).toEqual(["undo b", "redo b"]);
    const stuck = record(none(), act("c", true));
    await expect(stepBack(stuck)).rejects.toThrow("offline");
    expect(stuck.past).toHaveLength(1);
    expect(await stepBack(none())).toBeNull();
    expect(record(back.history, act("d")).future).toEqual([]);
  });
});
