import { gantt } from "@blackline/tender";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, newCompany, testServer, type TestServer } from "./helpers.js";

let s: TestServer;
beforeAll(async () => { s = await testServer(); });
afterAll(async () => { await s.close(); });

describe("the Gantt package", () => {
  it("is started by an estimator, once, with a project and the standard calendar", async () => {
    const { owner } = await newCompany(s, "Gantt Co");
    const eli = await addPerson(s, owner, "Eli", "estimator");
    const vic = await addPerson(s, owner, "Vic", "viewer");
    const job = (await owner.post("/jobs", { name: "Roads" })).body.id;

    expect((await vic.client.post(`/jobs/${job}/gantt`, {})).status).toBe(403);
    const a = await eli.client.post(`/jobs/${job}/gantt`, { start: "2026-10-05" });
    expect(a.status).toBe(201);
    expect(a.body.created).toBe(true);
    const again = await eli.client.post(`/jobs/${job}/gantt`, { start: "2027-01-01" });
    expect([again.status, again.body.created, again.body.packageId]).toEqual([200, false, a.body.packageId]);
    expect((await eli.client.post(`/jobs/${job}/gantt`, { start: "not a date" })).status).toBe(400);

    const all = (await owner.get(`/jobs/${job}/records`)).body as { packages: { id: string; key: string; kind: string }[]; records: { id: string; packageId: string; data: any }[] };
    expect(all.packages.filter((p) => p.key === "gantt")).toHaveLength(1);
    const project = gantt.assembleGantt(all.records.map((r) => ({ id: r.id, data: r.data })))!;
    expect([project.name, project.start, project.tasks.length, project.calendars[0]!.name]).toEqual(["Roads", "2026-10-05T08:00:00", 0, "Standard"]);
  });

  it("is checked out and checked in like any package, and its tasks come back in row order", async () => {
    const { owner } = await newCompany(s, "Gantt Two");
    const eli = await addPerson(s, owner, "Eli", "estimator");
    const job = (await owner.post("/jobs", { name: "Roads" })).body.id;
    const pkg = (await eli.client.post(`/jobs/${job}/gantt`, { start: "2026-10-05" })).body.packageId as string;

    expect((await eli.client.post(`/packages/${pkg}/checkout`)).status).toBe(200);
    const mk = (uid: number, name: string, seq: number, days: number, links: gantt.Link[] = []) => {
      const t = gantt.newTask(uid, name); t.durationMin = days * 480; t.links = links;
      return [`gtask:${uid}`, { kind: "ganttTask", seq, body: t }] as const;
    };
    const upserts = Object.fromEntries([mk(2, "Fill", 2000, 2, [{ uid: 1, type: "FS", lagMin: 0 }]), mk(1, "Strip", 1000, 5)]);
    const out = await eli.client.post(`/packages/${pkg}/checkin`, { baseVersion: 1, upserts, deletes: [] });
    expect([out.status, out.body.version]).toEqual([200, 2]);

    const all = (await owner.get(`/jobs/${job}/records`)).body.records as { id: string; data: any }[];
    const project = gantt.assembleGantt(all)!;
    expect(project.tasks.map((t) => t.name)).toEqual(["Strip", "Fill"]);
    const sch = gantt.schedule(project);
    expect(sch.byUid.get(2)!.start).toBe("2026-10-12T08:00:00");
    expect(sch.finish).toBe("2026-10-13T17:00:00");
  });

  it("belongs to one company: another company can't start or see it", async () => {
    const { owner } = await newCompany(s, "Gantt Three");
    const other = await newCompany(s, "Gantt Four");
    const job = (await owner.post("/jobs", { name: "Roads" })).body.id;
    expect((await other.owner.post(`/jobs/${job}/gantt`, {})).status).toBe(404);
  });
});
