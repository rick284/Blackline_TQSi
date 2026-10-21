/**
 * The job workspace: the checked-in records from the server, the estimator's drafts on packages they hold, and the actions that move
 * between them (check out, edit, check in, release, break). Drafts and lock versions are kept in localStorage and the cached copy of
 * the job in IndexedDB, so a refresh, a closed lid or a lost connection loses nothing. A check-in made offline is queued and sent when
 * the connection returns. The server stays the authority: it decides every check-in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordData } from "@blackline/tender/core";
import { api, ApiError, useConnection } from "./api.js";
import { addRecord, changeSetOf, countChanges, deleteRecord, discardPackage, editRecord, effectiveRecords, setRecord, type Drafts, type ServerRecord } from "./lib/draft.js";
import type { Parked } from "./lib/parked.js";
import { kv } from "./lib/kv.js";
import { buildModel, nextUid } from "./lib/model.js";
import { flushQueue, type SendOutcome } from "./lib/queue.js";
import type { Session } from "./session.js";

export interface PackageSummary {
  id: string;
  key: string;
  name: string;
  kind: string;
  version: number;
  records: number;
  lock: { holder: string; holder_name: string; base_version: number; taken_at: string } | null;
}

export interface Notice { kind: "info" | "warn" | "error"; text: string }

/** What is kept on this computer between visits: drafts, the lock version each held package was taken at, and queued check-ins. */
interface Saved { drafts: Drafts; held: Record<string, number>; queued?: Record<string, true> }
interface Loaded { packages: PackageSummary[]; records: ServerRecord[] }
const wsKey = (jobId: string) => `bl:ws:${jobId}`;
const cacheKey = (jobId: string) => `job:${jobId}`;
const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; } };
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or unavailable: the app still works */ } };

export function useWorkspace(jobId: string, session: Session) {
  const conn = useConnection();
  const [records, setRecords] = useState<ServerRecord[] | null>(null);
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [parked, setParked] = useState<Parked[]>([]);
  const [saved, setSaved] = useState<Saved>(() => read<Saved>(wsKey(jobId), { drafts: {}, held: {} }));
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  // StrictMode runs this effect's cleanup once on mount, so the flag must be set again each time the effect runs
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // the latest state for code that runs later (a queued check-in sent on reconnect must use what is current then, not what was current when it was queued)
  const savedRef = useRef(saved);
  const packagesRef = useRef(packages);
  packagesRef.current = packages;
  const persist = useCallback((next: Saved) => { savedRef.current = next; setSaved(next); write(wsKey(jobId), next); }, [jobId]);

  const load = useCallback(async () => {
    try {
      const r = await api<Loaded>("GET", `/jobs/${jobId}/records`);
      if (!alive.current) return;
      setRecords(r.records);
      setPackages(r.packages);
      setFromCache(false);
      void kv.set(cacheKey(jobId), r);
      // changes the server refused and kept: a person compares them on the Parked changes screen
      api<Parked[]>("GET", `/jobs/${jobId}/parked`).then((p) => alive.current && setParked(p)).catch(() => undefined);
    } catch (e) {
      const c = e instanceof ApiError && e.status === 0 ? await kv.get<Loaded>(cacheKey(jobId)) : undefined;
      if (!alive.current) return;
      if (c) {
        setRecords(c.records);
        setPackages(c.packages);
        setFromCache(true);
      } else setNotice({ kind: "error", text: e instanceof ApiError && e.status === 0 ? "You are offline and this job has not been opened on this computer yet." : e instanceof ApiError ? e.message : "Could not load this job." });
    }
    if (alive.current) setLoading(false);
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  const { drafts, held } = saved;
  const queued = saved.queued ?? {};
  const effective = useMemo(() => (records ? effectiveRecords(records, drafts) : []), [records, drafts]);
  const model = useMemo(() => (records ? buildModel(effective) : null), [records, effective]);

  const pkg = useCallback((id: string) => packages.find((p) => p.id === id), [packages]);
  /** Whether the estimator holds this package: the server says the lock is theirs. */
  const isMine = useCallback((id: string) => pkg(id)?.lock?.holder === session.userId, [pkg, session.userId]);
  const canEdit = useCallback((id: string) => isMine(id) && session.role !== "viewer", [isMine, session.role]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try { await fn(); } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 0) setNotice({ kind: "warn", text: "No connection. Your edits are saved on this computer; this needs a connection." });
      else setNotice({ kind: "error", text: e instanceof ApiError ? e.message : String(e) });
    }
    if (alive.current) setBusy(false);
  }, []);

  const dropHeld = (s: Saved, id: string): Saved => {
    const { [id]: _h, ...restHeld } = s.held;
    const { [id]: _q, ...restQueued } = s.queued ?? {};
    return { drafts: discardPackage(s.drafts, id), held: restHeld, queued: restQueued };
  };

  /** One check-in attempt. Reads the current state, so it is the same code for a click and for a queued check-in sent later. */
  const sendCheckIn = useCallback(async (id: string): Promise<SendOutcome> => {
    const s = savedRef.current;
    const { upserts, deletes } = changeSetOf(id, s.drafts);
    const base = s.held[id] ?? packagesRef.current.find((p) => p.id === id)?.lock?.base_version ?? 1;
    try {
      const r = await api<{ version: number }>("POST", `/packages/${id}/checkin`, { baseVersion: base, upserts, deletes });
      persist(dropHeld(savedRef.current, id));
      return { kind: "ok", version: r.version };
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return { kind: "offline" };
      if (e instanceof ApiError && e.status === 409 && e.extra.parkedId) {
        persist(dropHeld(savedRef.current, id));
        return { kind: "refused", message: e.message };
      }
      return { kind: "error", message: e instanceof ApiError ? e.message : String(e) };
    }
  }, [persist]);

  const say = (name: string, o: SendOutcome): Notice =>
    o.kind === "ok" ? { kind: "info", text: `${name} checked in as version ${o.version}. The lock is released.` }
    : o.kind === "refused" ? { kind: "warn", text: `${name} was refused: ${o.message} Your changes were not applied. They are kept for a manager to compare.` }
    : { kind: "error", text: `${name}: ${o.kind === "error" ? o.message : "no connection"}` };

  const checkOut = useCallback((id: string) => run(async () => {
    const r = await api<{ version: number }>("POST", `/packages/${id}/checkout`);
    persist({ ...savedRef.current, held: { ...savedRef.current.held, [id]: r.version } });
    await load();
    setNotice({ kind: "info", text: "Checked out. Nobody else can change this package until you check it in." });
  }), [run, persist, load]);

  const checkIn = useCallback((id: string) => run(async () => {
    const name = packagesRef.current.find((p) => p.id === id)?.name ?? "The package";
    const o = await sendCheckIn(id);
    if (o.kind === "offline") {
      persist({ ...savedRef.current, queued: { ...(savedRef.current.queued ?? {}), [id]: true } });
      setNotice({ kind: "warn", text: `${name} is queued. It will be checked in as soon as you are back online. Your edits stay saved on this computer.` });
      return;
    }
    setNotice(say(name, o));
    await load();
  }), [run, sendCheckIn, persist, load]);

  const cancelQueued = useCallback((id: string) => {
    const { [id]: _q, ...rest } = savedRef.current.queued ?? {};
    persist({ ...savedRef.current, queued: rest });
    setNotice({ kind: "info", text: "Queued check-in cancelled. Your edits are still here." });
  }, [persist]);

  // back online: send queued check-ins in order, then refresh what everyone else has done
  const flushing = useRef(false);
  const waiting = Object.keys(queued).length;
  useEffect(() => {
    if (conn !== "online" || waiting === 0 || flushing.current) return;
    flushing.current = true;
    void (async () => {
      const ids = Object.keys(savedRef.current.queued ?? {});
      const { finished } = await flushQueue(ids, sendCheckIn);
      // anything that was answered leaves the queue; an offline answer leaves it (and the rest) queued
      const q = { ...(savedRef.current.queued ?? {}) };
      for (const id of Object.keys(finished)) delete q[id];
      persist({ ...savedRef.current, queued: q });
      flushing.current = false;
      const notes = Object.entries(finished).map(([id, o]) => say(packagesRef.current.find((p) => p.id === id)?.name ?? "A package", o));
      if (alive.current && notes.length) setNotice(notes.some((n) => n.kind !== "info") ? notes.find((n) => n.kind !== "info")! : { kind: "info", text: `Back online: ${notes.length} queued check-in${notes.length === 1 ? "" : "s"} sent.` });
      if (alive.current) await load();
    })();
  }, [conn, waiting, sendCheckIn, persist, load]);

  // back online with nothing queued: refresh, so other people's check-ins and locks show up
  const wasOffline = useRef(false);
  useEffect(() => {
    if (conn === "offline") wasOffline.current = true;
    else if (wasOffline.current && waiting === 0) { wasOffline.current = false; void load(); }
  }, [conn, waiting, load]);

  const resolveParked = useCallback((id: string) => run(async () => {
    await api("POST", `/parked/${id}/resolve`);
    setParked((p) => p.filter((x) => x.id !== id));
    setNotice({ kind: "info", text: "Marked as dealt with." });
  }), [run]);

  // A question to the person is asked in the page (a bar above the grid), never in a browser pop-up.
  const [ask, setAsk] = useState<{ text: string; label: string; go: () => void } | null>(null);

  const doRelease = useCallback((id: string) => run(async () => {
    await api("POST", `/packages/${id}/release`);
    persist(dropHeld(savedRef.current, id));
    await load();
    setNotice({ kind: "info", text: "Released. The package is free for others." });
  }), [run, persist, load]);

  const release = useCallback((id: string) => {
    if (countChanges(savedRef.current.drafts, id)) setAsk({ text: "Discard your unsaved changes and release this package?", label: "Discard and release", go: () => void doRelease(id) });
    else void doRelease(id);
  }, [doRelease]);

  const doBreak = useCallback((id: string) => run(async () => {
    await api("POST", `/packages/${id}/break-lock`);
    await load();
    setNotice({ kind: "warn", text: "Lock broken. The package is back at its last checked-in version." });
  }), [run, load]);

  const breakLock = useCallback((id: string) => {
    setAsk({ text: `Break ${packagesRef.current.find((p) => p.id === id)?.lock?.holder_name ?? "their"} lock? Their unsaved work will be refused if they check in later.`, label: "Break the lock", go: () => void doBreak(id) });
  }, [doBreak]);

  const answer = useCallback((yes: boolean) => { const a = ask; setAsk(null); if (yes && a) a.go(); }, [ask]);
  // ---- drafting (always local; the server is only told at check-in)
  const edit = useCallback((packageId: string, recordId: string, fn: (body: any) => any) => {
    if (!records || !canEdit(packageId)) return;
    persist({ ...savedRef.current, drafts: editRecord(savedRef.current.drafts, records, packageId, recordId, fn) });
  }, [records, canEdit, persist]);

  const addRow = useCallback((packageId: string, qsCode: string) => {
    if (!records || !canEdit(packageId)) return;
    const uids = effective.filter((r) => r.data.kind === "row").map((r) => (r.data.body as any).uid as string);
    const uid = nextUid(qsCode, uids);
    const seq = 1 + Math.max(0, ...effective.filter((r) => r.data.kind === "row").map((r) => r.data.seq ?? 0));
    const data: RecordData = {
      kind: "row", seq,
      body: { qsCode, mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "", manualQty: "1", count: null, productivityRate: null, durationOverrideHrs: null,
              utilisation: null, waste: null, jobRateOverride: null, task: "", verified: "No", weatherExposed: "", weatherTaskType: "", uid },
    };
    persist({ ...savedRef.current, drafts: addRecord(savedRef.current.drafts, packageId, `row:${uid}`, data) });
  }, [records, canEdit, effective, persist]);

  /** Put a whole record (or its deletion) into the draft, for bringing a parked change across. */
  const adopt = useCallback((packageId: string, recordId: string, data: RecordData | null) => {
    if (!records || !canEdit(packageId)) return;
    persist({ ...savedRef.current, drafts: setRecord(savedRef.current.drafts, records, packageId, recordId, data) });
  }, [records, canEdit, persist]);

  const addRate = useCallback((packageId: string, code: string) => {
    if (!records || !canEdit(packageId)) return;
    const seq = 1 + Math.max(0, ...effective.filter((r) => r.data.kind === "library").map((r) => r.data.seq ?? 0));
    const data: RecordData = { kind: "library", seq, body: { code, description: "", unit: "", baseRate: "0", category: "", operatorIncluded: "", fuelIncluded: "", source: "" } };
    persist({ ...savedRef.current, drafts: addRecord(savedRef.current.drafts, packageId, `library:${code}`, data) });
  }, [records, canEdit, effective, persist]);

  const record = useCallback((id: string) => effective.find((r) => r.id === id)?.data, [effective]);
  const nextSeq = useCallback((kind: string) => 1 + Math.max(0, ...effective.filter((r) => r.data.kind === kind).map((r) => r.data.seq ?? 0)), [effective]);

  /** Save a built labour rate: the library rate and the build that produced it go into the draft together. */
  const saveLabour = useCallback((packageId: string, code: string, library: RecordData, build: RecordData) => {
    if (!records || !canEdit(packageId)) return;
    const d = setRecord(setRecord(savedRef.current.drafts, records, packageId, `library:${code}`, library), records, packageId, `labour:${code}`, build);
    persist({ ...savedRef.current, drafts: d });
  }, [records, canEdit, persist]);

  const removeRow = useCallback((packageId: string, recordId: string) => {
    if (!records || !canEdit(packageId)) return;
    persist({ ...savedRef.current, drafts: deleteRecord(savedRef.current.drafts, records, packageId, recordId) });
  }, [records, canEdit, persist]);

  return {
    loading, fromCache, records, packages, parked, model, drafts, notice, busy, queued, ask, answer,
    changes: (id?: string) => countChanges(drafts, id),
    totalChanges: countChanges(drafts),
    queuedCount: waiting,
    heldByMe: packages.filter((p) => p.lock?.holder === session.userId),
    notify: setNotice, isMine, canEdit, pkg, load, checkOut, checkIn, cancelQueued, release, breakLock, resolveParked, edit, adopt, addRow, removeRow, addRate, saveLabour, record, nextSeq, removeRate: removeRow, dismiss: () => setNotice(null),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
