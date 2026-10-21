/**
 * Package checkout and check-in. Pure functions over an immutable Store, so the
 * same rules run on the server (authoritative) and in tests with two simulated clients.
 *
 * Rules (see ARCHITECTURE.md):
 *  - A package is checked out by one person; nobody else can check it out or in.
 *  - A check-in is accepted only if the lock is still held by that person and the
 *    package is still at the version they took.
 *  - A manager can break a lock. A check-in against a broken lock is never applied;
 *    the change set is parked for a person to compare and choose.
 *  - Append-only records (quotes, RFIs, timesheets) never conflict and need no lock.
 */

export interface Pkg {
  id: string;
  version: number;
  records: Record<string, unknown>;
}

export interface Lock {
  packageId: string;
  holder: string;
  baseVersion: number;
  takenAt: string;
}

export interface ChangeSet {
  upserts: Record<string, unknown>;
  deletes: string[];
}

export interface ParkedChange {
  packageId: string;
  holder: string;
  baseVersion: number;
  changes: ChangeSet;
  reason: RefusalReason;
  at: string;
}

export interface AuditEvent {
  at: string;
  who: string;
  action: "check-out" | "check-in" | "break-lock" | "refused";
  packageId: string;
  detail?: string;
}

export interface Store {
  packages: Record<string, Pkg>;
  locks: Record<string, Lock>;
  parked: ParkedChange[];
  appendOnly: Record<string, unknown>;
  audit: AuditEvent[];
}

export type RefusalReason =
  | "unknown-package"
  | "already-checked-out"
  | "no-lock"
  | "not-holder"
  | "stale-base"
  | "not-manager"
  | "not-locked";

export type Result<T> = ({ ok: true; store: Store } & T) | { ok: false; reason: RefusalReason; store: Store };

export function createStore(packages: Pkg[] = []): Store {
  return {
    packages: Object.fromEntries(packages.map((p) => [p.id, p])),
    locks: {},
    parked: [],
    appendOnly: {},
    audit: [],
  };
}

const log = (s: Store, e: AuditEvent): Store => ({ ...s, audit: [...s.audit, e] });

export function checkOut(
  store: Store,
  packageId: string,
  who: string,
  now: string,
): Result<{ snapshot: Pkg }> {
  const pkg = store.packages[packageId];
  if (!pkg) return { ok: false, reason: "unknown-package", store };
  if (store.locks[packageId]) return { ok: false, reason: "already-checked-out", store };
  const lock: Lock = { packageId, holder: who, baseVersion: pkg.version, takenAt: now };
  const next = log(
    { ...store, locks: { ...store.locks, [packageId]: lock } },
    { at: now, who, action: "check-out", packageId },
  );
  return { ok: true, store: next, snapshot: structuredClone(pkg) };
}

export function checkIn(
  store: Store,
  packageId: string,
  who: string,
  baseVersion: number,
  changes: ChangeSet,
  now: string,
): Result<{ version: number }> {
  const pkg = store.packages[packageId];
  if (!pkg) return { ok: false, reason: "unknown-package", store };

  const refuse = (reason: RefusalReason): Result<{ version: number }> => {
    const parked: ParkedChange = { packageId, holder: who, baseVersion, changes, reason, at: now };
    const next = log(
      { ...store, parked: [...store.parked, parked] },
      { at: now, who, action: "refused", packageId, detail: reason },
    );
    return { ok: false, reason, store: next };
  };

  const lock = store.locks[packageId];
  if (!lock) return refuse("no-lock");
  if (lock.holder !== who) return refuse("not-holder");
  if (lock.baseVersion !== baseVersion || pkg.version !== baseVersion) return refuse("stale-base");

  const records = { ...pkg.records, ...changes.upserts };
  for (const id of changes.deletes) delete records[id];
  const version = pkg.version + 1;
  const { [packageId]: _released, ...locks } = store.locks;
  const next = log(
    { ...store, packages: { ...store.packages, [packageId]: { id: packageId, version, records } }, locks },
    { at: now, who, action: "check-in", packageId, detail: `v${version}` },
  );
  return { ok: true, store: next, version };
}

export function breakLock(
  store: Store,
  packageId: string,
  who: string,
  isManager: boolean,
  now: string,
): Result<{ brokenFrom: string }> {
  if (!isManager) return { ok: false, reason: "not-manager", store };
  const lock = store.locks[packageId];
  if (!lock) return { ok: false, reason: "not-locked", store };
  const { [packageId]: _gone, ...locks } = store.locks;
  const next = log(
    { ...store, locks },
    { at: now, who, action: "break-lock", packageId, detail: `was held by ${lock.holder}` },
  );
  return { ok: true, store: next, brokenFrom: lock.holder };
}

/** Add-only records are idempotent by id: the first write wins and a replay is harmless. */
export function appendRecord(store: Store, id: string, value: unknown): Store {
  if (id in store.appendOnly) return store;
  return { ...store, appendOnly: { ...store.appendOnly, [id]: value } };
}
