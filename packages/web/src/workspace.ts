/**
 * The job workspace: the checked-in records from the server, the estimator's drafts on packages they hold, and the actions that move
 * between them (check out, edit, check in, release, break). Drafts and lock versions are kept in localStorage so a refresh, a closed
 * lid or a lost connection loses nothing. The server stays the authority: it decides every check-in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RecordData } from "@blackline/tender/core";
import { api, ApiError } from "./api.js";
import { addRecord, changeSetOf, countChanges, deleteRecord, discardPackage, editRecord, effectiveRecords, type Drafts, type ServerRecord } from "./lib/draft.js";
import { buildModel, nextUid } from "./lib/model.js";
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

interface Saved { drafts: Drafts; held: Record<string, number> }
const wsKey = (jobId: string) => `bl:ws:${jobId}`;
const cacheKey = (jobId: string) => `bl:cache:${jobId}`;
const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; } };
const write = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or unavailable: the app still works */ } };

export function useWorkspace(jobId: string, session: Session) {
  const [records, setRecords] = useState<ServerRecord[] | null>(null);
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [saved, setSaved] = useState<Saved>(() => read<Saved>(wsKey(jobId), { drafts: {}, held: {} }));
  const [loading, setLoading] = useState(true);
  const [fromCache, setFromCache] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  // StrictMode runs this effect's cleanup once on mount, so the flag must be set again each time the effect runs
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const persist = useCallback((next: Saved) => { setSaved(next); write(wsKey(jobId), next); }, [jobId]);

  const load = useCallback(async () => {
    try {
      const r = await api<{ packages: PackageSummary[]; records: ServerRecord[] }>("GET", `/jobs/${jobId}/records`);
      if (!alive.current) return;
      setRecords(r.records);
      setPackages(r.packages);
      setFromCache(false);
      write(cacheKey(jobId), r);
    } catch (e) {
      const c = read<{ packages: PackageSummary[]; records: ServerRecord[] } | null>(cacheKey(jobId), null);
      if (e instanceof ApiError && e.status === 0 && c) {
        setRecords(c.records);
        setPackages(c.packages);
        setFromCache(true);
      } else if (alive.current) setNotice({ kind: "error", text: e instanceof ApiError ? e.message : "Could not load this job." });
    }
    if (alive.current) setLoading(false);
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  const { drafts, held } = saved;
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

  const checkOut = useCallback((id: string) => run(async () => {
    const r = await api<{ version: number }>("POST", `/packages/${id}/checkout`);
    persist({ drafts, held: { ...held, [id]: r.version } });
    await load();
    setNotice({ kind: "info", text: "Checked out. Nobody else can change this package until you check it in." });
  }), [run, persist, drafts, held, load]);

  const checkIn = useCallback((id: string) => run(async () => {
    const { upserts, deletes } = changeSetOf(id, drafts);
    const base = held[id] ?? pkg(id)?.lock?.base_version ?? 1;
    try {
      const r = await api<{ version: number }>("POST", `/packages/${id}/checkin`, { baseVersion: base, upserts, deletes });
      const { [id]: _h, ...restHeld } = held;
      persist({ drafts: discardPackage(drafts, id), held: restHeld });
      setNotice({ kind: "info", text: `Checked in as version ${r.version}. The lock is released.` });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.extra.parkedId) {
        const { [id]: _h, ...restHeld } = held;
        persist({ drafts: discardPackage(drafts, id), held: restHeld });
        setNotice({ kind: "warn", text: `Check-in refused: ${e.message} Your changes were not applied. They are kept for a manager to compare.` });
      } else throw e;
    }
    await load();
  }), [run, drafts, held, pkg, persist, load]);

  const release = useCallback((id: string) => run(async () => {
    if (countChanges(drafts, id) && !window.confirm("Discard your unsaved changes and release this package?")) return;
    await api("POST", `/packages/${id}/release`);
    const { [id]: _h, ...restHeld } = held;
    persist({ drafts: discardPackage(drafts, id), held: restHeld });
    await load();
    setNotice({ kind: "info", text: "Released. The package is free for others." });
  }), [run, drafts, held, persist, load]);

  const breakLock = useCallback((id: string) => run(async () => {
    if (!window.confirm(`Break ${pkg(id)?.lock?.holder_name ?? "their"} lock? Their unsaved work will be refused if they check in later.`)) return;
    await api("POST", `/packages/${id}/break-lock`);
    await load();
    setNotice({ kind: "warn", text: "Lock broken. The package is back at its last checked-in version." });
  }), [run, pkg, load]);

  // ---- drafting (always local; the server is only told at check-in)
  const edit = useCallback((packageId: string, recordId: string, fn: (body: any) => any) => {
    if (!records || !canEdit(packageId)) return;
    persist({ drafts: editRecord(drafts, records, packageId, recordId, fn), held });
  }, [records, canEdit, persist, drafts, held]);

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
    persist({ drafts: addRecord(drafts, packageId, `row:${uid}`, data), held });
  }, [records, canEdit, effective, persist, drafts, held]);

  const removeRow = useCallback((packageId: string, recordId: string) => {
    if (!records || !canEdit(packageId)) return;
    persist({ drafts: deleteRecord(drafts, records, packageId, recordId), held });
  }, [records, canEdit, persist, drafts, held]);

  return {
    loading, fromCache, records, packages, model, drafts, notice, busy,
    changes: (id?: string) => countChanges(drafts, id),
    totalChanges: countChanges(drafts),
    heldByMe: packages.filter((p) => p.lock?.holder === session.userId),
    notify: setNotice, isMine, canEdit, pkg, load, checkOut, checkIn, release, breakLock, edit, addRow, removeRow, dismiss: () => setNotice(null),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
