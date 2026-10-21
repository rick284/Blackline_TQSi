/**
 * Checkout and check-in on the database. The rules are the ones in @blackline/checkout, which stays the single authority:
 * this code loads the package's lock into that module's Store, asks it, and then makes the database say the same thing.
 * Each call is one transaction on the package row, so two people can never both win the same lock.
 */
import { breakLock, type ChangeSet, checkIn, checkOut, createStore, type RefusalReason, type Store } from "@blackline/checkout";
import type { RecordData } from "@blackline/tender";
import type { Db } from "../db.js";
import { type Ctx, HttpError, requireRole } from "../errors.js";
import { audit } from "./audit.js";
import { getJob } from "./jobs.js";

const REASON_TEXT: Record<RefusalReason, string> = {
  "unknown-package": "That package does not exist.",
  "already-checked-out": "Someone already has that package checked out.",
  "no-lock": "You no longer hold this package: its lock was released or broken.",
  "not-holder": "Another person holds this package.",
  "stale-base": "The package has changed since you checked it out.",
  "not-manager": "Only a manager can break a lock.",
  "not-locked": "That package is not checked out.",
};

interface PkgRow { id: string; job_id: string; key: string; name: string; version: number }

/** The package and its lock as the pure module's Store. The records are not needed to decide, so they are left out. */
async function loadStore(t: Db, ctx: Ctx, packageId: string): Promise<{ pkg: PkgRow; store: Store }> {
  const pkg = (await t.query<PkgRow>("select id, job_id, key, name, version from packages where id = $1 and org_id = $2 for update", [packageId, ctx.orgId])).rows[0];
  if (!pkg) throw new HttpError(404, "not_found", "Package not found.");
  const store = createStore([{ id: pkg.id, version: pkg.version, records: {} }]);
  const lock = (await t.query<{ holder: string; base_version: number; taken_at: string }>("select holder, base_version, taken_at from locks where package_id = $1", [packageId])).rows[0];
  if (lock) store.locks[pkg.id] = { packageId: pkg.id, holder: lock.holder, baseVersion: lock.base_version, takenAt: String(lock.taken_at) };
  return { pkg, store };
}

const refuse = (reason: RefusalReason, status = 409) => new HttpError(status, reason.replace(/-/g, "_"), REASON_TEXT[reason]);

export async function checkOutPackage(db: Db, ctx: Ctx, packageId: string) {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    const { pkg, store } = await loadStore(t, ctx, packageId);
    const r = checkOut(store, pkg.id, ctx.userId, new Date().toISOString());
    if (!r.ok) throw refuse(r.reason);
    await t.query("insert into locks (package_id, org_id, holder, base_version) values ($1, $2, $3, $4)", [pkg.id, ctx.orgId, ctx.userId, pkg.version]);
    await audit(t, ctx, "package.checked_out", { jobId: pkg.job_id, packageId: pkg.id, detail: { version: pkg.version } });
    const recs = (await t.query<{ record_id: string; data: RecordData }>("select record_id, data from package_records where package_id = $1 and org_id = $2 order by record_id", [pkg.id, ctx.orgId])).rows;
    return { id: pkg.id, key: pkg.key, name: pkg.name, version: pkg.version, records: Object.fromEntries(recs.map((x) => [x.record_id, x.data])) };
  });
}

export type CheckInResult = { accepted: true; version: number } | { accepted: false; reason: RefusalReason; message: string; parkedId: string };

/**
 * Apply one person's change set. It is accepted only if they still hold the lock and the package is still at the version they took.
 * Otherwise nothing is applied: the change set is parked for a person to compare and choose, and the refusal is returned.
 */
export async function checkInPackage(db: Db, ctx: Ctx, packageId: string, baseVersion: number, changes: ChangeSet): Promise<CheckInResult> {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    const { pkg, store } = await loadStore(t, ctx, packageId);
    const r = checkIn(store, pkg.id, ctx.userId, baseVersion, changes, new Date().toISOString());
    if (!r.ok) {
      const parked = (await t.query<{ id: string }>(
        "insert into parked_changes (org_id, package_id, holder, base_version, changes, reason) values ($1, $2, $3, $4, $5, $6) returning id",
        [ctx.orgId, pkg.id, ctx.userId, baseVersion, JSON.stringify(changes), r.reason])).rows[0]!;
      await audit(t, ctx, "package.checkin_refused", { jobId: pkg.job_id, packageId: pkg.id, detail: { reason: r.reason, baseVersion, parkedId: parked.id } });
      return { accepted: false, reason: r.reason, message: REASON_TEXT[r.reason], parkedId: parked.id } as const;
    }
    for (const [recordId, data] of Object.entries(changes.upserts)) {
      await t.query("insert into record_versions (package_id, org_id, record_id, version, data) values ($1, $2, $3, $4, $5)", [pkg.id, ctx.orgId, recordId, r.version, JSON.stringify(data)]);
      await t.query(
        `insert into package_records (package_id, org_id, record_id, data) values ($1, $2, $3, $4)
         on conflict (package_id, record_id) do update set data = excluded.data`, [pkg.id, ctx.orgId, recordId, JSON.stringify(data)]);
    }
    for (const recordId of changes.deletes) {
      await t.query("delete from package_records where package_id = $1 and record_id = $2", [pkg.id, recordId]);
      await t.query("insert into record_versions (package_id, org_id, record_id, version, data) values ($1, $2, $3, $4, null)", [pkg.id, ctx.orgId, recordId, r.version]);
    }
    await t.query("update packages set version = $2 where id = $1", [pkg.id, r.version]);
    await t.query("delete from locks where package_id = $1", [pkg.id]);
    await audit(t, ctx, "package.checked_in", { jobId: pkg.job_id, packageId: pkg.id, detail: { version: r.version, upserts: Object.keys(changes.upserts).length, deletes: changes.deletes.length } });
    return { accepted: true, version: r.version } as const;
  });
}

/** Give up a checkout without changing anything. Only the holder can do this; a manager breaks someone else's lock instead. */
export async function releaseLock(db: Db, ctx: Ctx, packageId: string): Promise<void> {
  requireRole(ctx, "estimator");
  await db.tx(async (t) => {
    const { pkg, store } = await loadStore(t, ctx, packageId);
    const lock = store.locks[pkg.id];
    if (!lock) throw refuse("not-locked");
    if (lock.holder !== ctx.userId) throw refuse("not-holder", 403);
    await t.query("delete from locks where package_id = $1", [pkg.id]);
    await audit(t, ctx, "package.released", { jobId: pkg.job_id, packageId: pkg.id });
  });
}

/**
 * A manager frees a package whose holder is lost or away. The package stays at its last checked-in version. If the holder later
 * checks in, that is refused and parked: the compare-and-choose screen is the only place such work is brought back.
 */
export async function breakPackageLock(db: Db, ctx: Ctx, packageId: string): Promise<{ brokenFrom: string }> {
  requireRole(ctx, "manager");
  return db.tx(async (t) => {
    const { pkg, store } = await loadStore(t, ctx, packageId);
    const r = breakLock(store, pkg.id, ctx.userId, true, new Date().toISOString());
    if (!r.ok) throw refuse(r.reason);
    await t.query("delete from locks where package_id = $1", [pkg.id]);
    await audit(t, ctx, "package.lock_broken", { jobId: pkg.job_id, packageId: pkg.id, detail: { heldBy: r.brokenFrom } });
    return { brokenFrom: r.brokenFrom };
  });
}

export async function listParked(db: Db, ctx: Ctx, jobId: string) {
  await getJob(db, ctx, jobId);
  const rows = (await db.query<any>(
    `select c.id, c.package_id, p.name as package_name, c.holder, u.name as holder_name, c.base_version, c.reason, c.changes, c.created_at
       from parked_changes c
       join packages p on p.id = c.package_id and p.org_id = c.org_id
       join users u on u.id = c.holder
      where p.job_id = $1 and c.org_id = $2 and c.resolved_at is null
      order by c.created_at`, [jobId, ctx.orgId])).rows;
  // For every record the refused check-in touched, what it was at the version they checked out: the common starting point that lets a
  // person see what they actually changed. A record that did not exist then has no entry.
  for (const r of rows) {
    const ids = [...Object.keys(r.changes.upserts ?? {}), ...(r.changes.deletes ?? [])];
    const base = (await db.query<{ record_id: string; data: unknown }>(
      `select distinct on (record_id) record_id, data from record_versions
        where package_id = $1 and org_id = $2 and record_id = any($3) and version <= $4
        order by record_id, version desc`, [r.package_id, ctx.orgId, ids, r.base_version])).rows;
    r.base = Object.fromEntries(base.map((b) => [b.record_id, b.data]));
  }
  return rows;
}
/** A manager records that a parked change has been dealt with (brought across by a normal checkout, or set aside). */
export async function resolveParked(db: Db, ctx: Ctx, parkedId: string): Promise<void> {
  requireRole(ctx, "manager");
  await db.tx(async (t) => {
    const row = (await t.query<{ package_id: string }>(
      "update parked_changes set resolved_at = now(), resolved_by = $3 where id = $1 and org_id = $2 and resolved_at is null returning package_id", [parkedId, ctx.orgId, ctx.userId])).rows[0];
    if (!row) throw new HttpError(404, "not_found", "No open parked change with that id.");
    await audit(t, ctx, "parked.resolved", { packageId: row.package_id, detail: { parkedId } });
  });
}

/** Add-only records: never conflict, need no lock, and the first write wins so a replay is harmless. */
export async function appendJobRecord(db: Db, ctx: Ctx, jobId: string, recordId: string, data: unknown): Promise<{ created: boolean }> {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    await getJob(t, ctx, jobId);
    const r = await t.query(
      "insert into append_records (org_id, job_id, record_id, data, created_by) values ($1, $2, $3, $4, $5) on conflict (job_id, record_id) do nothing returning record_id",
      [ctx.orgId, jobId, recordId, JSON.stringify(data), ctx.userId]);
    if (r.rows.length) await audit(t, ctx, "record.appended", { jobId, detail: { recordId } });
    return { created: r.rows.length === 1 };
  });
}
