import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gantt as G, type RecordData } from "@blackline/tender/core";
import { api, ApiError } from "../api.js";
import * as X from "../lib/gantt.js";
import { COLUMNS, COLUMN_BY_KEY, FILTERS, arrange, canEditCell, isFiltering, NO_FILTER, type Ctx, type FilterKind } from "../lib/ganttColumns.js";
import { assign, parseAssignments, taskTotals } from "../lib/ganttResources.js";
import { MAX_LEFT, MIN_LEFT, nextSort, parseSettings, settingsKey, type GanttSettings, type View } from "../lib/ganttSettings.js";
import { ZOOMS, makeScale, zoomIn, zoomOut, type Zoom } from "../lib/ganttView.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";
import { GanttCalendars } from "./GanttCalendars.js";
import { GanttChart, type ChartRow, type End } from "./GanttChart.js";
import { GanttColumns } from "./GanttColumns.js";
import { GanttInfo } from "./GanttInfo.js";
import { GanttResources } from "./GanttResources.js";
import { GanttTable, tableWidth } from "./GanttTable.js";
import { PackageBar } from "./PackageBar.js";

type Tab = "File" | "Task" | "View" | "Project";
const ZOOM_NAMES: Record<Zoom, string> = { quarters: "Quarters", months: "Months", weeks: "Weeks", days: "Days" };
const VIEW_NAMES: Record<View, string> = { chart: "Gantt Chart", resources: "Resource Sheet", calendars: "Calendars" };

const localNow = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`; };

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name.replace(/[\\/:*?"<>|]+/g, "-");
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * The Gantt: Blackline's own MS Project. A task table beside a timeline, a ribbon with the same groups MS Project has, Task Information
 * docked beside the chart, links drawn by dragging from one bar to another, and a file MS Project opens (File > Open, XML). Three views:
 * the Gantt Chart, the Resource Sheet and Change Working Time (calendars). The tasks are records in the Gantt package, so they are checked
 * out, edited with undo and redo, and checked in like everything else. How the table is shown (columns, sort, filter, zoom) is the
 * person's own and is kept on this computer.
 */
export function Gantt({ ws, jobId }: { ws: Workspace; jobId: string }) {
  const { session } = useSession();
  const model = ws.model!;
  const project = model.gantt;
  const sched = model.ganttSchedule;
  const pkgId = model.ganttPackageId;
  const rows = model.ganttRows as X.Row[];
  const editable = !!pkgId && ws.canEdit(pkgId);

  const [settings, setSettings] = useState<GanttSettings>(() => { try { return parseSettings(localStorage.getItem(settingsKey(jobId))); } catch { return parseSettings(null); } });
  const patch = useCallback((p: Partial<GanttSettings>) => setSettings((s) => ({ ...s, ...p })), []);
  useEffect(() => { try { localStorage.setItem(settingsKey(jobId), JSON.stringify(settings)); } catch { /* the view still works, it just isn't remembered */ } }, [jobId, settings]);
  const { zoom, showCritical, showBaseline, sort, filter } = settings;

  const [view, setView] = useState<View>("chart");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [panel, setPanel] = useState<"info" | "columns" | null>("info");
  const [editing, setEditing] = useState<{ uid: number; col: string } | null>(null);
  const [tab, setTab] = useState<Tab>("Task");
  const tableRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [width, setWidth] = useState(900);

  const cal = useMemo(() => project?.calendars.find((c) => c.uid === project.calendarUid) ?? project?.calendars[0] ?? G.standardCalendar(), [project]);
  const wc = useMemo(() => new G.WorkCalendar(cal), [cal]);
  const todayMin = G.toMin(localNow());
  const joined: ChartRow[] = useMemo(() => (sched ? rows.map((r) => ({ task: r.task, s: sched.byUid.get(r.task.uid)! })).filter((r) => r.s) : []), [rows, sched]);
  const totals = useMemo(() => (project && sched ? taskTotals(project, sched) : new Map()), [project, sched]);
  const ctx: Ctx | null = project && sched ? { project, sched, totals, wc, today: todayMin } : null;
  const columns = useMemo(() => settings.columns.map((k) => COLUMN_BY_KEY.get(k)!).filter(Boolean), [settings.columns]);
  const arranged = useMemo(() => (ctx ? arrange(joined, { filter, sort, collapsed }, ctx) : { rows: [], filtered: false, sorted: false }), [joined, filter, sort, collapsed, project, sched, totals]); // eslint-disable-line react-hooks/exhaustive-deps
  const vis = arranged.rows;
  const idOf = useCallback((uid: number) => sched?.byUid.get(uid)?.id, [sched]);
  const uidOf = useCallback((id: number) => sched?.tasks[id - 1]?.uid, [sched]);
  const mpd = project?.minutesPerDay ?? 480;
  const leftW = Math.min(tableWidth(columns), settings.leftW);

  const scale = useMemo(() => {
    const firsts = joined.map((r) => r.s.startMin), lasts = joined.map((r) => r.s.finishMin);
    const ps = project ? G.toMin(project.start) : G.toMin(localNow());
    return makeScale(zoom, Math.min(ps, ...firsts), Math.max(ps + 1440, ...lasts), width);
  }, [joined, project, zoom, width]);

  useEffect(() => {
    const el = chartRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [!!project, view]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- changing the project
  const selUids = useMemo(() => rows.filter((r) => selected.has(r.task.uid)).map((r) => r.task.uid), [rows, selected]);
  const say = (kind: "info" | "warn", text: string) => ws.notify({ kind, text });

  /** Write the rows that differ from what is stored: one step for undo. Refuses a change that would make a loop of links. */
  const commit = (next: X.Row[]): boolean => {
    if (!project || !editable) return false;
    const d = X.diff(rows, next);
    if (!d.upserts.length && !d.deletes.length) return true;
    const after = G.schedule({ ...project, tasks: next.map((r) => r.task) });
    if (after.problems.some((p) => p.includes("loop")) && !sched!.problems.some((p) => p.includes("loop"))) { say("warn", "That would make a loop of links, so it wasn't done."); return false; }
    const items: { recordId: string; data: RecordData | null }[] = [
      ...d.upserts.map((u) => ({ recordId: `gtask:${u.uid}`, data: { kind: "ganttTask", seq: u.seq, body: u.task } as RecordData })),
      ...d.deletes.map((uid) => ({ recordId: `gtask:${uid}`, data: null })),
      ...project.assignments.filter((a) => d.deletes.includes(a.taskUid)).map((a) => ({ recordId: `gasg:${a.uid}`, data: null })),
    ];
    ws.batch(pkgId, items);
    return true;
  };
  const updateTask = (uid: number, fn: (t: G.GTask) => G.GTask | string) => {
    const t = rows.find((r) => r.task.uid === uid);
    if (!t) return;
    const r = fn(t.task);
    if (typeof r === "string") { say("warn", r); return; }
    commit(rows.map((x) => (x.task.uid === uid ? { task: r, seq: x.seq } : x)));
  };
  /** Put exactly these resources on a task (text like "Digger, Labourer[50%]"); a new name becomes a resource. Returns a sentence when it can't. */
  const setResources = (uid: number, text: string): string | null => {
    if (!project) return null;
    const w = parseAssignments(text, project.resources);
    if (!w.ok) { say("warn", w.error); return w.error; }
    const ch = assign(project, uid, w.wanted);
    ws.batch(pkgId, [
      ...ch.resources.map((r) => ({ recordId: `gres:${r.uid}`, data: { kind: "ganttResource", body: r } as RecordData })),
      ...ch.upserts.map((a) => ({ recordId: `gasg:${a.uid}`, data: { kind: "ganttAssignment", body: a } as RecordData })),
      ...ch.deletes.map((id) => ({ recordId: `gasg:${id}`, data: null })),
    ]);
    return null;
  };

  const select = useCallback((uid: number, mode: "one" | "toggle" | "range") => {
    setSelected((cur) => {
      if (mode === "toggle") { const n = new Set(cur); n.has(uid) ? n.delete(uid) : n.add(uid); return n; }
      if (mode === "range" && anchor !== null) {
        const a = vis.findIndex((r) => r.task.uid === anchor), b = vis.findIndex((r) => r.task.uid === uid);
        if (a >= 0 && b >= 0) return new Set(vis.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.task.uid));
      }
      return new Set([uid]);
    });
    if (mode !== "range") setAnchor(uid);
  }, [anchor, vis]);

  const doInsert = (kind: X.InsertKind) => {
    const r = X.insert(rows, selUids, kind);
    if (commit(r.rows)) { setSelected(new Set([r.uid])); setAnchor(r.uid); setEditing({ uid: r.uid, col: "name" }); }
  };
  const doDelete = () => {
    if (!selUids.length) return;
    const r = X.remove(rows, selUids);
    const go = () => { commit(r.rows); setSelected(new Set()); };
    if (r.removed.length > selUids.length) ws.confirm(`Delete ${selUids.length === 1 ? "this summary task" : "these tasks"} and the ${r.removed.length - selUids.length} task${r.removed.length - selUids.length === 1 ? "" : "s"} inside? You can undo this.`, "Delete", go);
    else go();
  };
  const doLink = () => { const r = X.linkTasks(rows, selUids); if (r.added) commit(r.rows); if (r.skipped.length) say("warn", r.skipped[0]!); else if (!r.added) say("info", "Select two or more tasks to link."); };
  const doMove = (dir: -1 | 1) => { if (arranged.sorted) { say("info", "The table is sorted, so the order can't be changed. Choose Sort by ID first."); return; } commit(X.move(rows, selUids, dir)); };

  /** One cell, typed. Returns a sentence when it can't be taken. */
  const editCell = (uid: number, col: string, text: string): string | null => {
    const t = rows.find((r) => r.task.uid === uid)?.task;
    if (!t || !project) return null;
    if (col === "resources") return setResources(uid, text);
    let err: string | null = null;
    updateTask(uid, (x) => {
      if (col === "name") return text.trim() ? { ...x, name: text.trim().slice(0, 200) } : (err = "A task needs a name.");
      if (col === "duration") { const d = X.parseDuration(text, mpd, project.minutesPerWeek); return d === null ? (err = `"${text}" isn't a duration. Try 5d, 4h or 2w.`) : { ...x, durationMin: d, milestone: d === 0 }; }
      if (col === "start") { const d = X.parseDate(text, "08:00:00"); return d ? { ...x, constraint: "SNET", constraintDate: d } : (err = `"${text}" isn't a date. Try 5/10/26.`); }
      if (col === "finish") { const d = X.parseDate(text, "17:00:00"); return d ? { ...x, constraint: "FNET", constraintDate: d } : (err = `"${text}" isn't a date. Try 5/10/26.`); }
      if (col === "deadline") { if (!text.trim()) return { ...x, deadline: null }; const d = X.parseDate(text, "17:00:00"); return d ? { ...x, deadline: d } : (err = `"${text}" isn't a date. Try 5/10/26.`); }
      if (col === "pred") { const r = X.parseLinks(text, uidOf, uid, mpd, project.minutesPerWeek); return r.ok ? { ...x, links: r.links } : (err = r.error); }
      if (col === "percent") { if (/^\s*\d{1,3}\s*%?\s*$/.test(text) && parseInt(text, 10) <= 100) return { ...x, percent: parseInt(text, 10) }; return (err = "% Complete is a number from 0 to 100."); }
      return x;
    });
    return err;
  };
  const onCommit = (uid: number, col: string, text: string, then: "down" | "right" | "stay", changed: boolean) => {
    setEditing(null);
    if (changed) editCell(uid, col, text);
    if (then === "down") {
      const i = vis.findIndex((r) => r.task.uid === uid);
      const next = vis[i + 1];
      if (next) { setSelected(new Set([next.task.uid])); setAnchor(next.task.uid); }
    } else if (then === "right") {
      const row = vis.find((r) => r.task.uid === uid);
      const keys = settings.columns;
      const k = row ? keys.slice(keys.indexOf(col) + 1).find((c) => canEditCell(c, row)) : undefined;
      if (k) setTimeout(() => setEditing({ uid, col: k }), 0);
    }
  };

  // ---- the chart's drags
  const onMove = (uid: number, days: number) => {
    const r = joined.find((x) => x.task.uid === uid);
    if (!r || r.s.summary) return;
    updateTask(uid, (x) => ({ ...x, constraint: "SNET", constraintDate: G.fromMin(r.s.startMin + days * 1440) }));
  };
  const onResize = (uid: number, days: number) => {
    const r = joined.find((x) => x.task.uid === uid);
    if (!r || r.s.summary || r.task.milestone) return;
    const dur = wc.between(r.s.startMin, wc.prevEnd(r.s.finishMin + days * 1440));
    updateTask(uid, (x) => ({ ...x, durationMin: Math.max(mpd, Math.round(dur / mpd) * mpd) }));
  };
  const onLink = (from: number, fromEnd: End, to: number, toEnd: End) => {
    const type = fromEnd === "finish" ? (toEnd === "start" ? "FS" : "FF") : (toEnd === "start" ? "SS" : "SF");
    const r = X.addLink(rows, from, to, type);
    if (r.added) commit(r.rows); else say("warn", r.skipped[0]!);
  };

  // ---- the divider between the table and the chart
  const startSplit = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, w0 = leftW;
    const move = (ev: PointerEvent) => patch({ leftW: Math.min(MAX_LEFT, Math.max(MIN_LEFT, Math.round(w0 + ev.clientX - x0))) });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---- file
  const exportFile = () => { if (project) download(`${project.name}.xml`, G.exportMspdi(project, { savedAt: localNow() }), "application/xml"); };
  const replaceWith = (p: G.GProject, what: string) => {
    const seed = G.ganttSeedPackage(p).records;
    const items: { recordId: string; data: RecordData | null }[] = [
      ...model.ganttRecordIds.filter((id) => !(id in seed)).map((id) => ({ recordId: id, data: null })),
      ...Object.entries(seed).map(([recordId, data]) => ({ recordId, data })),
    ];
    const go = () => { ws.batch(pkgId, items); setSelected(new Set()); setCollapsed(new Set()); };
    if (rows.length) ws.confirm(`Replace the ${rows.length} task${rows.length === 1 ? "" : "s"} in the Gantt with ${what}? You can undo this.`, "Replace", go); else go();
  };
  const importFile = async (f: File) => {
    try {
      const r = G.importMspdi(await f.text());
      replaceWith(r.project, `${r.project.tasks.length} task${r.project.tasks.length === 1 ? "" : "s"} from ${f.name}`);
      if (r.warnings.length) say("warn", r.warnings.join(" "));
    } catch (e) { say("warn", e instanceof Error ? e.message : "That file could not be read."); }
  };
  const fromProgramme = () => {
    const prog = model.estimate.programme;
    if (!project || "setUp" in prog) { say("info", "The Programme has no tasks yet. Start it on the Programme window first."); return; }
    const next = G.newProject(model.programme?.start ? `${model.programme.start}T08:00:00` : project.start, project.name);
    next.calendars = project.calendars; next.calendarUid = project.calendarUid; next.resources = project.resources;
    const r = X.fromProgramme(prog.tasks.map((t) => ({ code: t.code, name: t.name, section: t.section, duration: t.duration, predecessors: t.predecessors, hammock: t.hammock })), mpd);
    next.tasks = r.map((x) => x.task);
    const seed = G.ganttSeedPackage(next).records;
    const items: { recordId: string; data: RecordData | null }[] = [
      ...model.ganttRecordIds.filter((id) => !(id in seed) && !id.startsWith("gcal:") && !id.startsWith("gres:")).map((id) => ({ recordId: id, data: null })),
      ...Object.entries(seed).map(([recordId, data]) => ({ recordId, data })),
    ];
    const go = () => { ws.batch(pkgId, items); setSelected(new Set()); };
    if (rows.length) ws.confirm(`Replace the ${rows.length} task${rows.length === 1 ? "" : "s"} in the Gantt with the ${prog.tasks.length} from the Programme? You can undo this.`, "Replace", go); else go();
  };
  const setConfig = (field: "start" | "statusDate", text: string) => {
    const d = field === "statusDate" && !text.trim() ? null : X.parseDate(text, field === "start" ? "08:00:00" : "17:00:00");
    if (!d && !(field === "statusDate" && !text.trim())) { say("warn", `"${text}" isn't a date. Try 5/10/26.`); return; }
    ws.edit(pkgId, "gantt:config", (b) => ({ ...b, [field]: d }));
  };

  // ---- keyboard, as MS Project has it
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      if (view !== "chart" || !project || !editable) return;
      const k = e.key;
      if (e.altKey && e.shiftKey && k === "ArrowRight") { e.preventDefault(); commit(X.indent(rows, selUids)); }
      else if (e.altKey && e.shiftKey && k === "ArrowLeft") { e.preventDefault(); commit(X.outdent(rows, selUids)); }
      else if (e.altKey && e.shiftKey && k === "ArrowUp") { e.preventDefault(); doMove(-1); }
      else if (e.altKey && e.shiftKey && k === "ArrowDown") { e.preventDefault(); doMove(1); }
      else if (e.ctrlKey && k === "F2") { e.preventDefault(); if (e.shiftKey) commit(X.unlinkTasks(rows, selUids)); else doLink(); }
      else if (k === "Delete") { e.preventDefault(); doDelete(); }
      else if (k === "Insert") { e.preventDefault(); doInsert("task"); }
      else if ((k === "Enter" || k === "F2") && selUids.length === 1) { e.preventDefault(); setEditing({ uid: selUids[0]!, col: "name" }); }
      else if ((k === "ArrowDown" || k === "ArrowUp") && !e.altKey && !e.ctrlKey) {
        e.preventDefault();
        const cur = vis.findIndex((r) => r.task.uid === (anchor ?? selUids[0]));
        const n = vis[Math.min(vis.length - 1, Math.max(0, cur + (k === "ArrowDown" ? 1 : -1)))];
        if (n) select(n.task.uid, e.shiftKey ? "range" : "one");
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const startGantt = async () => {
    try {
      await api("POST", `/jobs/${jobId}/gantt`, model.programme?.start ? { start: model.programme.start } : {});
      await ws.load();
    } catch (e) { say("warn", e instanceof ApiError ? e.message : "The Gantt could not be started."); }
  };

  // ---- not started
  if (!project || !sched || !ctx) {
    return (
      <div className="page">
        {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
        <h4>Gantt</h4>
        <p className="muted">The Gantt is a full planning chart, like MS Project: any tasks, links, calendars and constraints, with a file MS Project can open. It is kept as its own package, so a planner can work on it while an estimator works on the Programme.</p>
        <button className="btn primary" disabled={session!.role === "viewer"} onClick={startGantt}>Start the Gantt for this job</button>
      </div>
    );
  }

  const one = selUids.length === 1 ? joined.find((r) => r.task.uid === selUids[0]) : undefined;
  const ro = !editable;
  const b = (label: string, on: () => void, opts: { disabled?: boolean; title?: string; on?: boolean } = {}) => (
    <button className={`btn rbtn${opts.on ? " on" : ""}`} disabled={opts.disabled ?? ro} onClick={on} title={opts.title}>{label}</button>
  );
  const progress = (n: number) => b(`${n}%`, () => commit(X.setPercent(rows, selUids.filter((u) => !sched.byUid.get(u)!.summary), n)), { disabled: ro || !selUids.length, title: `Mark the selected tasks ${n}% complete` });
  const crit = sched.tasks.filter((t) => t.critical && !t.summary).length;
  const setFilter = (f: Partial<typeof filter>) => patch({ filter: { ...filter, ...f } });

  return (
    <>
      <PackageBar ws={ws} pkgId={pkgId} />
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="ribbon" role="tablist" aria-label="Ribbon">
        {(["File", "Task", "View", "Project"] as Tab[]).map((t) => <button key={t} role="tab" aria-selected={tab === t} className={`rtab${tab === t ? " on" : ""}`} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div className="ribbon-body">
        {tab === "File" && (
          <>
            <div className="rgroup"><div className="rrow">
              {b("Export to MS Project", exportFile, { disabled: false, title: "Save an XML file MS Project opens (File > Open)" })}
              {b("Import from MS Project", () => fileRef.current?.click(), { title: "Read an MS Project XML file (File > Save As > XML in MS Project)" })}
              <input ref={fileRef} type="file" accept=".xml,text/xml,application/xml" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importFile(f); }} />
            </div><div className="rcap">MS Project file</div></div>
            <div className="rgroup"><div className="rrow">{b("Build from the Programme", fromProgramme, { title: "Make Gantt tasks from the tender Programme" })}</div><div className="rcap">Tender programme</div></div>
          </>
        )}
        {tab === "Task" && (
          <>
            <div className="rgroup"><div className="rrow">{b("Task", () => doInsert("task"), { title: "Insert a task above the selected one (Insert)" })}{b("Summary", () => doInsert("summary"), { title: "Insert a summary task and put the selected tasks under it" })}{b("Milestone", () => doInsert("milestone"))}{b("Delete", doDelete, { disabled: ro || !selUids.length, title: "Delete the selected tasks (Delete)" })}</div><div className="rcap">Insert</div></div>
            <div className="rgroup"><div className="rrow">
              {b("Link", doLink, { disabled: ro || selUids.length < 2, title: "Link the selected tasks, finish to start (Ctrl+F2)" })}
              {b("Unlink", () => commit(X.unlinkTasks(rows, selUids)), { disabled: ro || !selUids.length, title: "Remove the links (Ctrl+Shift+F2)" })}
              {b("Indent", () => commit(X.indent(rows, selUids)), { disabled: ro || !selUids.length, title: "Make the selected tasks part of the summary above (Alt+Shift+Right)" })}
              {b("Outdent", () => commit(X.outdent(rows, selUids)), { disabled: ro || !selUids.length, title: "Alt+Shift+Left" })}
              {b("Move up", () => doMove(-1), { disabled: ro || !selUids.length || arranged.sorted, title: arranged.sorted ? "The table is sorted. Choose Sort by ID first." : "Alt+Shift+Up" })}
              {b("Move down", () => doMove(1), { disabled: ro || !selUids.length || arranged.sorted, title: arranged.sorted ? "The table is sorted. Choose Sort by ID first." : "Alt+Shift+Down" })}
              {b(one && !one.task.active ? "Activate" : "Inactivate", () => commit(X.setActive(rows, selUids, !(one && !one.task.active))), { disabled: ro || !selUids.length, title: "Take the task out of the schedule (it stays in the project)" })}
            </div><div className="rcap">Schedule</div></div>
            <div className="rgroup"><div className="rrow">{[0, 25, 50, 75, 100].map(progress)}</div><div className="rcap">Mark complete</div></div>
            <div className="rgroup"><div className="rrow">{b("Information", () => setPanel(panel === "info" ? null : "info"), { disabled: false, on: panel === "info", title: "Task Information" })}</div><div className="rcap">Properties</div></div>
          </>
        )}
        {tab === "View" && (
          <>
            <div className="rgroup"><div className="rrow">
              {(Object.keys(VIEW_NAMES) as View[]).map((v) => b(VIEW_NAMES[v], () => setView(v), { disabled: false, on: view === v }))}
            </div><div className="rcap">Views</div></div>
            <div className="rgroup"><div className="rrow">
              {b("Zoom in", () => patch({ zoom: zoomIn(zoom) }), { disabled: zoom === "days" || view !== "chart" })}{b("Zoom out", () => patch({ zoom: zoomOut(zoom) }), { disabled: zoom === "quarters" || view !== "chart" })}
              <select value={zoom} onChange={(e) => patch({ zoom: e.target.value as Zoom })} aria-label="Timescale" className="rsel">{ZOOMS.map((z) => <option key={z} value={z}>{ZOOM_NAMES[z]}</option>)}</select>
            </div><div className="rcap">Zoom</div></div>
            <div className="rgroup"><div className="rrow rfields">
              <label>Sort by
                <select className="rsel" value={sort?.key ?? ""} aria-label="Sort by" onChange={(e) => patch({ sort: e.target.value ? { key: e.target.value, dir: sort?.dir ?? "asc" } : null })}>
                  <option value="">ID (project order)</option>
                  {COLUMNS.filter((c) => c.key !== "id").map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
                </select>
              </label>
              {b(sort?.dir === "desc" ? "Descending" : "Ascending", () => sort && patch({ sort: { ...sort, dir: sort.dir === "asc" ? "desc" : "asc" } }), { disabled: !sort, title: "Change the direction" })}
              {b("Sort by ID", () => patch({ sort: null }), { disabled: !sort, title: "Back to the project's own order" })}
            </div><div className="rcap">Sort</div></div>
            <div className="rgroup"><div className="rrow rfields">
              <label>Filter
                <select className="rsel" value={filter.kind} aria-label="Filter" onChange={(e) => setFilter({ kind: e.target.value as FilterKind })}>
                  {FILTERS.map((f) => <option key={f.kind} value={f.kind}>{f.label}</option>)}
                </select>
              </label>
              {filter.kind === "resource" && (
                <select className="rsel" value={filter.resourceUid ?? ""} aria-label="Resource" onChange={(e) => setFilter({ resourceUid: e.target.value === "" ? undefined : Number(e.target.value) })}>
                  <option value="">Pick a resource</option>
                  {project.resources.map((r) => <option key={r.uid} value={r.uid}>{r.name}</option>)}
                </select>
              )}
              {filter.kind === "dates" && (
                <>
                  <input className="find" style={{ width: 92 }} placeholder="from 5/10/26" aria-label="From date" key={`f${filter.from ?? ""}`} defaultValue={filter.from ? X.formatDate(filter.from) : ""} onBlur={(e) => { const d = e.target.value.trim() ? X.parseDate(e.target.value, "00:00:00") : undefined; if (e.target.value.trim() && !d) say("warn", `"${e.target.value}" isn't a date. Try 5/10/26.`); else setFilter({ from: d ?? undefined }); }} />
                  <input className="find" style={{ width: 92 }} placeholder="to 30/10/26" aria-label="To date" key={`t${filter.to ?? ""}`} defaultValue={filter.to ? X.formatDate(filter.to) : ""} onBlur={(e) => { const d = e.target.value.trim() ? X.parseDate(e.target.value, "00:00:00") : undefined; if (e.target.value.trim() && !d) say("warn", `"${e.target.value}" isn't a date. Try 5/10/26.`); else setFilter({ to: d ?? undefined }); }} />
                </>
              )}
              <input className="find" style={{ width: 130 }} placeholder="Find in name, notes" aria-label="Find in tasks" value={filter.text} onChange={(e) => setFilter({ text: e.target.value })} />
              {b("Clear filter", () => patch({ filter: { ...NO_FILTER } }), { disabled: !isFiltering(filter) })}
            </div><div className="rcap">Filter</div></div>
            <div className="rgroup"><div className="rrow">{b("Columns", () => setPanel(panel === "columns" ? null : "columns"), { disabled: false, on: panel === "columns", title: "Choose the columns in the table" })}</div><div className="rcap">Table</div></div>
            <div className="rgroup"><div className="rrow">
              <label className="rchk"><input type="checkbox" checked={showCritical} onChange={(e) => patch({ showCritical: e.target.checked })} /> Critical tasks</label>
              <label className="rchk"><input type="checkbox" checked={showBaseline} onChange={(e) => patch({ showBaseline: e.target.checked })} /> Baseline</label>
            </div><div className="rcap">Gantt chart</div></div>
            <div className="rgroup"><div className="rrow">
              {b("Scroll to task", () => { const r = one ?? joined[0]; if (r && chartRef.current) chartRef.current.scrollLeft = Math.max(0, (r.s.startMin - scale.startMin) * scale.pxPerMin - 60); }, { disabled: false })}
              {b("Today", () => { if (chartRef.current) chartRef.current.scrollLeft = Math.max(0, (todayMin - scale.startMin) * scale.pxPerMin - 200); }, { disabled: false })}
              {b("Collapse all", () => setCollapsed(new Set(sched.tasks.filter((t) => t.summary).map((t) => t.uid))), { disabled: false })}
              {b("Expand all", () => setCollapsed(new Set()), { disabled: false })}
            </div><div className="rcap">Outline</div></div>
          </>
        )}
        {tab === "Project" && (
          <>
            <div className="rgroup"><div className="rrow rfields">
              <label>Start <input className="find" style={{ width: 110 }} key={project.start} defaultValue={X.formatDate(project.start)} disabled={ro} aria-label="Project start" onBlur={(e) => e.target.value !== X.formatDate(project.start) && setConfig("start", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></label>
              <label>Status date <input className="find" style={{ width: 110 }} key={project.statusDate ?? "none"} defaultValue={X.formatDate(project.statusDate)} disabled={ro} aria-label="Status date" placeholder="none" onBlur={(e) => e.target.value !== X.formatDate(project.statusDate) && setConfig("statusDate", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></label>
            </div><div className="rcap">Project information</div></div>
            <div className="rgroup"><div className="rrow">
              {b("Change working time", () => setView("calendars"), { disabled: false, title: "Calendars, working hours and holidays" })}
              {b("Resource sheet", () => setView("resources"), { disabled: false })}
            </div><div className="rcap">Properties</div></div>
            <div className="rgroup"><div className="rrow">
              {b("Set baseline", () => commit(X.setBaseline(rows, sched, selUids.length ? selUids : undefined)), { title: selUids.length ? "Save the selected tasks' dates as the baseline" : "Save every task's dates as the baseline" })}
              {b("Clear baseline", () => commit(X.clearBaseline(rows, selUids.length ? selUids : undefined)))}
            </div><div className="rcap">Baseline {selUids.length ? "(selected tasks)" : "(whole project)"}</div></div>
          </>
        )}
      </div>
      <div className="prog-strip">
        <span><strong>{project.name}</strong></span>
        <span>{VIEW_NAMES[view]}</span>
        <span>{joined.length} task{joined.length === 1 ? "" : "s"}</span>
        <span>Start <strong>{X.formatDate(sched.start)}</strong></span>
        <span>Finish <strong>{X.formatDate(sched.finish)}</strong></span>
        <span><strong>{crit}</strong> critical</span>
        {arranged.filtered && view === "chart" && <span className="sep">Filtered: {vis.length} of {joined.length} rows shown <button className="linkbtn" onClick={() => patch({ filter: { ...NO_FILTER } })}>Clear</button></span>}
        {arranged.sorted && view === "chart" && sort && <span>Sorted by {COLUMN_BY_KEY.get(sort.key)?.title} {sort.dir === "asc" ? "▲" : "▼"} <button className="linkbtn" onClick={() => patch({ sort: null })}>Sort by ID</button></span>}
        {selUids.length > 0 && view === "chart" && <span className="sep">{selUids.length} selected</span>}
      </div>
      {sched.problems.length > 0 && <div className="notice warn wrap">{sched.problems.slice(0, 3).map((p) => <span key={p}>{p}</span>)}{sched.problems.length > 3 && <span>and {sched.problems.length - 3} more</span>}</div>}

      {view === "resources" && <GanttResources ws={ws} project={project} sched={sched} pkgId={pkgId} editable={editable} />}
      {view === "calendars" && <GanttCalendars ws={ws} project={project} pkgId={pkgId} editable={editable} />}
      {view === "chart" && (
        <div className="gantt">
          <div className="gantt-main">
            <div className="gantt-left" style={{ width: leftW }}>
              <GanttTable
                ref={tableRef} rows={vis} columns={columns} ctx={ctx} selected={selected} collapsed={collapsed} editing={editing} sort={sort} readOnly={ro}
                onSort={(k) => patch({ sort: nextSort(sort, k) })}
                onSelect={select} onToggle={(uid) => setCollapsed((c) => { const n = new Set(c); n.has(uid) ? n.delete(uid) : n.add(uid); return n; })}
                onEdit={setEditing} onCommit={onCommit} onWheel={(dy) => { if (chartRef.current) chartRef.current.scrollTop += dy; }}
              />
            </div>
            <div className="gantt-split" role="separator" aria-orientation="vertical" aria-label="Resize the table" onPointerDown={startSplit} />
            <GanttChart
              ref={chartRef} rows={vis} scale={scale} calendar={cal} selected={selected} showBaseline={showBaseline} showCritical={showCritical} today={todayMin}
              statusDate={project.statusDate ? G.toMin(project.statusDate) : null} readOnly={ro}
              onSelect={select} onMove={onMove} onResize={onResize} onLink={onLink}
              onScroll={(top) => { if (tableRef.current) tableRef.current.scrollTop = top; }}
            />
            {panel === "columns" && <GanttColumns keys={settings.columns} onChange={(columns) => patch({ columns })} onClose={() => setPanel(null)} />}
            {panel === "info" && one && <GanttInfo task={one.task} s={one.s} project={project} readOnly={ro} idOf={idOf} uidOf={uidOf} onEdit={updateTask} onAssign={setResources} onClose={() => setPanel(null)} />}
          </div>
          {joined.length === 0 && <div className="muted gantt-empty">No tasks yet. Use Task &gt; Task to insert one, or File &gt; Build from the Programme, or import an MS Project file.</div>}
          {joined.length > 0 && vis.length === 0 && <div className="muted gantt-empty">No task matches the filter. <button className="linkbtn" onClick={() => patch({ filter: { ...NO_FILTER } })}>Clear it</button></div>}
        </div>
      )}
    </>
  );
}
