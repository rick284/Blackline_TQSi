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
import * as history from "./lib/history.js";
import { syncAcross } from "./lib/syncDrafts.js";
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

  // Undo and redo: every change to the drafts remembers what they were. A package that is checked in or released drops its drafts, so the
  // history is cleared then (an undo must never bring back drafts of a package that is no longer yours). Kept in memory only.
  const hist = useRef(history.empty<Drafts>());
  const [, bumpHistory] = useState(0);
  const canEditRef = useRef<(id: string) => boolean>(() => false);
  const recordsRef = useRef<ServerRecord[] | null>(null);
  /** The tender Programme and the Gantt carry changes to each other: when the Gantt is linked and both packages are held, what an edit changes on one
   *  side is written to the other in the same step, so one undo takes back both. */
  const carry = useCallback((next: Drafts): { drafts: Drafts; note: Notice | null } => {
    const recs = recordsRef.current;
    const gantt = packagesRef.current.find((p) => p.kind === "gantt")?.id, programme = packagesRef.current.find((p) => p.kind === "programme")?.id;
    if (!recs || !gantt || !programme || !canEditRef.current(gantt) || !canEditRef.current(programme)) return { drafts: next, note: null };
    const s = syncAcross(recs, next, { gantt, programme });
    return { drafts: s.drafts, note: s.notes.length ? { kind: s.notes.length > 1 || s.notes[0]!.includes("kept") ? "warn" : "info", text: s.notes.join(" ") } : null };
  }, []);
  const commit = useCallback((next: Drafts, opts: { carry?: boolean } = {}) => {
    const before = savedRef.current.drafts;
    const c = opts.carry === false ? { drafts: next, note: null } : carry(next);
    if (JSON.stringify(before) === JSON.stringify(c.drafts)) return;
    hist.current = history.record(hist.current, before);
    bumpHistory((n) => n + 1);
    setNotice(c.note); // a warning about an earlier, refused value no longer applies once a change goes through
    persist({ ...savedRef.current, drafts: c.drafts });
  }, [persist, carry]);
  const forgetHistory = useCallback(() => { hist.current = history.empty<Drafts>(); bumpHistory((n) => n + 1); }, []);
  const undo = useCallback(() => {
    const r = history.undo(hist.current, savedRef.current.drafts);
    if (!r) return;
    hist.current = r.history;
    bumpHistory((n) => n + 1);
    persist({ ...savedRef.current, drafts: r.value });
  }, [persist]);
  const redo = useCallback(() => {
    const r = history.redo(hist.current, savedRef.current.drafts);
    if (!r) return;
    hist.current = r.history;
    bumpHistory((n) => n + 1);
    persist({ ...savedRef.current, drafts: r.value });
  }, [persist]);

  // Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z): not while typing in a box, where the box has its own undo
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [undo, redo]);

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
  canEditRef.current = canEdit;
  recordsRef.current = records;

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
      forgetHistory();
      return { kind: "ok", version: r.version };
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) return { kind: "offline" };
      if (e instanceof ApiError && e.status === 409 && e.extra.parkedId) {
        persist(dropHeld(savedRef.current, id));
        forgetHistory();
        return { kind: "refused", message: e.message };
      }
      return { kind: "error", message: e instanceof ApiError ? e.message : String(e) };
    }
  }, [persist, forgetHistory]);

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
    forgetHistory();
    await load();
    setNotice({ kind: "info", text: "Released. The package is free for others." });
  }), [run, persist, load, forgetHistory]);

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
    commit(editRecord(savedRef.current.drafts, records, packageId, recordId, fn));
  }, [records, canEdit, commit]);

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
    commit(addRecord(savedRef.current.drafts, packageId, `row:${uid}`, data));
  }, [records, canEdit, effective, commit]);

  /** Put a whole record (or its deletion) into the draft, for bringing a parked change across. */
  const adopt = useCallback((packageId: string, recordId: string, data: RecordData | null) => {
    if (!records || !canEdit(packageId)) return;
    commit(setRecord(savedRef.current.drafts, records, packageId, recordId, data));
  }, [records, canEdit, commit]);

  const addRate = useCallback((packageId: string, code: string) => {
    if (!records || !canEdit(packageId)) return;
    const seq = 1 + Math.max(0, ...effective.filter((r) => r.data.kind === "library").map((r) => r.data.seq ?? 0));
    const data: RecordData = { kind: "library", seq, body: { code, description: "", unit: "", baseRate: "0", category: "", operatorIncluded: "", fuelIncluded: "", source: "" } };
    commit(addRecord(savedRef.current.drafts, packageId, `library:${code}`, data));
  }, [records, canEdit, effective, commit]);

  const record = useCallback((id: string) => effective.find((r) => r.id === id)?.data, [effective]);
  const nextSeq = useCallback((kind: string) => 1 + Math.max(0, ...effective.filter((r) => r.data.kind === kind).map((r) => r.data.seq ?? 0)), [effective]);

  /** Save a built labour rate: the library rate and the build that produced it go into the draft together. */
  const saveLabour = useCallback((packageId: string, code: string, library: RecordData, build: RecordData) => {
    if (!records || !canEdit(packageId)) return;
    const d = setRecord(setRecord(savedRef.current.drafts, records, packageId, `library:${code}`, library), records, packageId, `labour:${code}`, build);
    commit(d);
  }, [records, canEdit, commit]);

  const removeRow = useCallback((packageId: string, recordId: string) => {
    if (!records || !canEdit(packageId)) return;
    commit(deleteRecord(savedRef.current.drafts, records, packageId, recordId));
  }, [records, canEdit, commit]);

  /** Delete several records as one step, so one undo puts them all back. Does nothing unless every package involved is yours. */
  const removeMany = useCallback((items: { packageId: string; recordId: string }[]) => {
    if (!records || items.length === 0 || !items.every((i) => canEdit(i.packageId))) return;
    commit(items.reduce((d, i) => deleteRecord(d, records, i.packageId, i.recordId), savedRef.current.drafts));
  }, [records, canEdit, commit]);

  /** Write and delete several records of one package as a single step (so one undo puts them all back). A record set to null is deleted. */
  const batch = useCallback((packageId: string, items: { recordId: string; data: RecordData | null }[]) => {
    if (!records || items.length === 0 || !canEdit(packageId)) return;
    commit(items.reduce((d, i) => setRecord(d, records, packageId, i.recordId, i.data), savedRef.current.drafts));
  }, [records, canEdit, commit]);

  /** Write records of more than one package as one step (the Gantt and the Programme together, say). Does nothing unless every package involved is yours. */
  const batchMulti = useCallback((items: { packageId: string; recordId: string; data: RecordData | null }[]) => {
    if (!records || items.length === 0 || !items.every((i) => canEdit(i.packageId))) return false;
    commit(items.reduce((d, i) => setRecord(d, records, i.packageId, i.recordId, i.data), savedRef.current.drafts));
    return true;
  }, [records, canEdit, commit]);

  /** Carry across whatever the Programme and the Gantt owe each other now, even if nothing else was edited (after checking out the second package). */
  const syncNow = useCallback(() => {
    const before = savedRef.current.drafts;
    const c = carry(before);
    if (c.drafts === before) { setNotice({ kind: "info", text: "The Programme and the Gantt are already in step, or one of them is not checked out." }); return; }
    hist.current = history.record(hist.current, before);
    bumpHistory((n) => n + 1);
    setNotice(c.note);
    persist({ ...savedRef.current, drafts: c.drafts });
  }, [carry, persist]);

  /** Ask in the page bar; `go` runs only if the person says yes. */
  const confirm = useCallback((text: string, label: string, go: () => void) => setAsk({ text, label, go }), []);

  return {
    loading, fromCache, records, packages, parked, model, drafts, notice, busy, queued, ask, answer,
    changes: (id?: string) => countChanges(drafts, id),
    totalChanges: countChanges(drafts),
    queuedCount: waiting,
    undo, redo, canUndo: hist.current.past.length > 0, canRedo: hist.current.future.length > 0,
    heldByMe: packages.filter((p) => p.lock?.holder === session.userId),
    notify: setNotice, isMine, canEdit, pkg, load, checkOut, checkIn, cancelQueued, release, breakLock, resolveParked, edit, adopt, addRow, removeRow, removeMany, batch, batchMulti, syncNow, confirm, addRate, saveLabour, record, nextSeq, removeRate: removeRow, dismiss: () => setNotice(null),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
