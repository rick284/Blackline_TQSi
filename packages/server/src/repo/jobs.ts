import type { RecordData, SeedPackage } from "@blackline/tender";
import type { Db } from "../db.js";
import { type Ctx, HttpError, type Role, requireRole } from "../errors.js";
import { audit } from "./audit.js";
import { updateEnquiry } from "./enquiries.js";

/** A job is also the enquiry: the register fields travel with it from the first phone call to the issued tender. */
export interface Job {
  id: string;
  name: string;
  client: string;
  status: string;
  created_at: string;
  contact_id: string | null;
  due_at: string | null;
  owner_id: string | null;
  owner_name: string | null;
  notes: string;
  approx_value: string;
  decision_reason: string;
  decided_at: string | null;
  archived_at: string | null;
}

/** The client shown is the linked contact's current name, so renaming a contact renames it everywhere; otherwise the name typed on the job. */
export const JOB_SELECT = `select j.id, j.name, coalesce(c.name, j.client) as client, j.status, j.created_at, j.contact_id, j.due_at, j.owner_id, ou.name as owner_name,
  j.notes, j.approx_value, j.decision_reason, j.decided_at, j.archived_at
  from jobs j left join contacts c on c.id = j.contact_id and c.org_id = j.org_id left join users ou on ou.id = j.owner_id`;

export interface NewJob { name: string; client?: string; contactId?: string | null; dueAt?: string | null; ownerId?: string | null; notes?: string; approxValue?: string }

export async function createJob(db: Db, ctx: Ctx, v: NewJob): Promise<Job> {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    if ((await t.query("select 1 from jobs where org_id = $1 and name = $2", [ctx.orgId, v.name])).rows.length)
      throw new HttpError(409, "job_exists", "A job with that name already exists.");
    const id = (await t.query<{ id: string }>("insert into jobs (org_id, name, client, created_by) values ($1, $2, $3, $4) returning id", [ctx.orgId, v.name, v.client ?? "", ctx.userId])).rows[0]!.id;
    await audit(t, ctx, "job.created", { jobId: id, detail: { name: v.name } });
    const { name: _n, client: _c, ...fields } = v;
    return Object.keys(fields).length ? updateEnquiry(t, ctx, id, fields, { quiet: true }) : getJob(t, ctx, id);
  });
}

export async function listJobs(db: Db, ctx: Ctx, o: { archived?: boolean } = {}): Promise<Job[]> {
  return (await db.query<Job>(`${JOB_SELECT} where j.org_id = $1 ${o.archived ? "" : "and j.archived_at is null"} order by j.created_at desc`, [ctx.orgId])).rows;
}

/** 404 for a job in another company, exactly as for one that does not exist: nothing reveals that it is there. */
export async function getJob(db: Db, ctx: Ctx, jobId: string): Promise<Job> {
  const job = (await db.query<Job>(`${JOB_SELECT} where j.id = $1 and j.org_id = $2`, [jobId, ctx.orgId])).rows[0];
  if (!job) throw new HttpError(404, "not_found", "Job not found.");
  return job;
}

export interface PackageSummary {
  id: string;
  key: string;
  name: string;
  kind: string;
  version: number;
  records: number;
  lock: { holder: string; holder_name: string; base_version: number; taken_at: string } | null;
}

export async function listPackages(db: Db, ctx: Ctx, jobId: string): Promise<PackageSummary[]> {
  await getJob(db, ctx, jobId);
  const rows = (await db.query<any>(
    `select p.id, p.key, p.name, p.kind, p.version,
            (select count(*)::int from package_records r where r.package_id = p.id) as records,
            l.holder, u.name as holder_name, l.base_version, l.taken_at
       from packages p
       left join locks l on l.package_id = p.id
       left join users u on u.id = l.holder
      where p.job_id = $1 and p.org_id = $2
      order by p.created_at, p.key`, [jobId, ctx.orgId])).rows;
  return rows.map((r) => ({
    id: r.id, key: r.key, name: r.name, kind: r.kind, version: r.version, records: r.records,
    lock: r.holder ? { holder: r.holder, holder_name: r.holder_name, base_version: r.base_version, taken_at: r.taken_at } : null,
  }));
}

/** Load a job's packages and records, for the first time only. A manager does this from an imported workbook or a blank template. */
export async function seedPackages(db: Db, ctx: Ctx, jobId: string, seeds: SeedPackage[], minRole: Role = "manager", via = "job.seeded"): Promise<{ packages: number; records: number }> {
  requireRole(ctx, minRole);
  return db.tx(async (t) => {
    await getJob(t, ctx, jobId);
    if ((await t.query("select 1 from packages where job_id = $1", [jobId])).rows.length)
      throw new HttpError(409, "job_not_empty", "This job already has an estimate. Check packages out to change them.");
    let records = 0;
    for (const s of seeds) {
      const pkg = (await t.query<{ id: string }>("insert into packages (org_id, job_id, key, name, kind) values ($1, $2, $3, $4, $5) returning id", [ctx.orgId, jobId, s.key, s.name, s.kind])).rows[0]!;
      for (const [recordId, data] of Object.entries(s.records)) {
        await t.query("insert into package_records (package_id, org_id, record_id, data) values ($1, $2, $3, $4)", [pkg.id, ctx.orgId, recordId, JSON.stringify(data)]);
        await t.query("insert into record_versions (package_id, org_id, record_id, version, data) values ($1, $2, $3, 1, $4)", [pkg.id, ctx.orgId, recordId, JSON.stringify(data)]);
        records++;
      }
    }
    await audit(t, ctx, via, { jobId, detail: { packages: seeds.length, records } });
    return { packages: seeds.length, records };
  });
}

/**
 * The Gantt package, added to a job that has none (jobs made before the Gantt existed, and new ones). Anyone who can check packages out may
 * start it; asking again changes nothing and returns the one already there.
 */
export async function ensurePackage(db: Db, ctx: Ctx, jobId: string, seed: SeedPackage): Promise<{ created: boolean; packageId: string }> {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    await getJob(t, ctx, jobId);
    const have = (await t.query<{ id: string }>("select id from packages where job_id = $1 and org_id = $2 and key = $3", [jobId, ctx.orgId, seed.key])).rows[0];
    if (have) return { created: false, packageId: have.id };
    const pkg = (await t.query<{ id: string }>("insert into packages (org_id, job_id, key, name, kind) values ($1, $2, $3, $4, $5) returning id", [ctx.orgId, jobId, seed.key, seed.name, seed.kind])).rows[0]!;
    for (const [recordId, data] of Object.entries(seed.records)) {
      await t.query("insert into package_records (package_id, org_id, record_id, data) values ($1, $2, $3, $4)", [pkg.id, ctx.orgId, recordId, JSON.stringify(data)]);
      await t.query("insert into record_versions (package_id, org_id, record_id, version, data) values ($1, $2, $3, 1, $4)", [pkg.id, ctx.orgId, recordId, JSON.stringify(data)]);
    }
    await audit(t, ctx, "package.created", { jobId, detail: { key: seed.key, records: Object.keys(seed.records).length } });
    return { created: true, packageId: pkg.id };
  });
}

export interface PackageDetail {
  id: string;
  key: string;
  name: string;
  kind: string;
  version: number;
  records: Record<string, RecordData>;
}

export async function getPackage(db: Db, ctx: Ctx, packageId: string): Promise<PackageDetail> {
  const p = (await db.query<any>("select id, key, name, kind, version from packages where id = $1 and org_id = $2", [packageId, ctx.orgId])).rows[0];
  if (!p) throw new HttpError(404, "not_found", "Package not found.");
  const recs = (await db.query<{ record_id: string; data: RecordData }>("select record_id, data from package_records where package_id = $1 and org_id = $2 order by record_id", [packageId, ctx.orgId])).rows;
  return { ...p, records: Object.fromEntries(recs.map((r) => [r.record_id, r.data])) };
}

/** Every checked-in record of a job with the package it belongs to: what a client loads to work on (and recalculate) a job. */
export async function jobRecordsByPackage(db: Db, ctx: Ctx, jobId: string): Promise<{ id: string; packageId: string; data: RecordData }[]> {
  await getJob(db, ctx, jobId);
  return (await db.query<{ id: string; package_id: string; data: RecordData }>(
    `select r.record_id as id, r.package_id, r.data
       from package_records r join packages p on p.id = r.package_id and p.org_id = r.org_id
      where p.job_id = $1 and p.org_id = $2 order by p.created_at, r.record_id`, [jobId, ctx.orgId])).rows.map((r) => ({ id: r.id, packageId: r.package_id, data: r.data }));
}

/** Every checked-in record of a job, across all its packages, ready for `assembleInputs`. */
export async function jobRecords(db: Db, ctx: Ctx, jobId: string): Promise<{ id: string; data: RecordData }[]> {
  await getJob(db, ctx, jobId);
  return (await db.query<{ id: string; data: RecordData }>(
    `select r.record_id as id, r.data
       from package_records r join packages p on p.id = r.package_id and p.org_id = r.org_id
      where p.job_id = $1 and p.org_id = $2`, [jobId, ctx.orgId])).rows;
}

/** Archiving takes a job out of the register without touching it; anyone who can create jobs may archive and restore. */
export async function setJobArchived(db: Db, ctx: Ctx, jobId: string, archived: boolean): Promise<Job> {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    await getJob(t, ctx, jobId);
    await t.query(`update jobs set archived_at = ${archived ? "coalesce(archived_at, now())" : "null"} where id = $1 and org_id = $2`, [jobId, ctx.orgId]);
    await audit(t, ctx, archived ? "job.archived" : "job.restored", { jobId });
    return getJob(t, ctx, jobId);
  });
}

/**
 * Delete a job and everything in it. A job that has been issued or awarded is never deleted: its revisions are frozen exactly as the client
 * received them, so it is archived instead. A job someone has checked a package out of is refused too, so nobody loses work in progress.
 */
export async function deleteJob(db: Db, ctx: Ctx, jobId: string): Promise<void> {
  requireRole(ctx, "manager");
  await db.tx(async (t) => {
    const job = await getJob(t, ctx, jobId);
    const frozen = (await t.query("select 1 from tender_revisions where job_id = $1 and org_id = $2 union all select 1 from contracts where job_id = $1 and org_id = $2", [jobId, ctx.orgId])).rows.length;
    if (frozen || job.status === "issued" || job.status === "awarded")
      throw new HttpError(409, "job_frozen", "This tender has been issued or awarded, so it is kept exactly as sent and can't be deleted. Archive it instead.");
    const held = (await t.query<{ name: string; holder: string }>("select u.name, l.holder from locks l join packages p on p.id = l.package_id join users u on u.id = l.holder where p.job_id = $1 and p.org_id = $2 limit 1", [jobId, ctx.orgId])).rows[0];
    if (held) throw new HttpError(409, "job_in_use", held.holder === ctx.userId ? "You have a package of this job checked out. Check it in or release it first." : `${held.name} has a package of this job checked out. Ask them to check it in or release it, or break the lock, first.`);
    await t.query("delete from jobs where id = $1 and org_id = $2", [jobId, ctx.orgId]);
    await audit(t, ctx, "job.deleted", { detail: { name: job.name, status: job.status } });
  });
}

/** A new job that starts as a copy of another's checked-in work: every package and record, at version 1, with nothing checked out. */
export async function copyJob(db: Db, ctx: Ctx, fromJobId: string, v: NewJob): Promise<Job> {
  requireRole(ctx, "manager");
  const pkgs = await listPackages(db, ctx, fromJobId);
  const recs = await jobRecordsByPackage(db, ctx, fromJobId);
  const seeds: SeedPackage[] = pkgs.map((p) => ({ key: p.key, name: p.name, kind: p.kind as SeedPackage["kind"], records: Object.fromEntries(recs.filter((r) => r.packageId === p.id).map((r) => [r.id, r.data])) }));
  const job = await createJob(db, ctx, v);
  if (seeds.length) await seedPackages(db, ctx, job.id, seeds, "manager", "job.copied");
  return job;
}
