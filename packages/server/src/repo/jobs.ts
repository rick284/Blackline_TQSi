import type { RecordData, SeedPackage } from "@blackline/tender";
import type { Db } from "../db.js";
import { type Ctx, HttpError, requireRole } from "../errors.js";
import { audit } from "./audit.js";

export interface Job {
  id: string;
  name: string;
  client: string;
  status: string;
  created_at: string;
}

const JOB_COLS = "id, name, client, status, created_at";

export async function createJob(db: Db, ctx: Ctx, v: { name: string; client?: string }): Promise<Job> {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    if ((await t.query("select 1 from jobs where org_id = $1 and name = $2", [ctx.orgId, v.name])).rows.length)
      throw new HttpError(409, "job_exists", "A job with that name already exists.");
    const job = (await t.query<Job>(`insert into jobs (org_id, name, client, created_by) values ($1, $2, $3, $4) returning ${JOB_COLS}`, [ctx.orgId, v.name, v.client ?? "", ctx.userId])).rows[0]!;
    await audit(t, ctx, "job.created", { jobId: job.id, detail: { name: v.name } });
    return job;
  });
}

export async function listJobs(db: Db, ctx: Ctx): Promise<Job[]> {
  return (await db.query<Job>(`select ${JOB_COLS} from jobs where org_id = $1 order by created_at desc`, [ctx.orgId])).rows;
}

/** 404 for a job in another company, exactly as for one that does not exist: nothing reveals that it is there. */
export async function getJob(db: Db, ctx: Ctx, jobId: string): Promise<Job> {
  const job = (await db.query<Job>(`select ${JOB_COLS} from jobs where id = $1 and org_id = $2`, [jobId, ctx.orgId])).rows[0];
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
export async function seedPackages(db: Db, ctx: Ctx, jobId: string, seeds: SeedPackage[]): Promise<{ packages: number; records: number }> {
  requireRole(ctx, "manager");
  return db.tx(async (t) => {
    await getJob(t, ctx, jobId);
    if ((await t.query("select 1 from packages where job_id = $1", [jobId])).rows.length)
      throw new HttpError(409, "job_not_empty", "This job already has an estimate. Check packages out to change them.");
    let records = 0;
    for (const s of seeds) {
      const pkg = (await t.query<{ id: string }>("insert into packages (org_id, job_id, key, name, kind) values ($1, $2, $3, $4, $5) returning id", [ctx.orgId, jobId, s.key, s.name, s.kind])).rows[0]!;
      for (const [recordId, data] of Object.entries(s.records)) {
        await t.query("insert into package_records (package_id, org_id, record_id, data) values ($1, $2, $3, $4)", [pkg.id, ctx.orgId, recordId, JSON.stringify(data)]);
        records++;
      }
    }
    await audit(t, ctx, "job.seeded", { jobId, detail: { packages: seeds.length, records } });
    return { packages: seeds.length, records };
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
