import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProgrammeTaskResult } from "@blackline/tender/core";
import { gridTheme, monoCell } from "../grid.js";
import { longDate, money } from "../lib/fmt.js";
import { newTask, setConfigField, setTaskFieldEdit, startFromEstimate, type ProgrammeConfig } from "../lib/programme.js";
import { hrefJob } from "../route.js";
import type { Workspace } from "../workspace.js";
import { PackageBar } from "./PackageBar.js";

const NEW = "__new";
type Row = ProgrammeTaskResult & { isNew?: boolean };
const blank = (): Row => ({ id: NEW, code: "", name: "", qs_code: "", section: "", amount: null, duration: 0, derived: null, override: null, predecessors: [], hammock: false, basis: "", note: "", es: 0, ef: 0, float: 0, critical: false, start: null, finish: null, isNew: true });
const isNew = (p: { node: { rowPinned?: string | null } }) => p.node.rowPinned === "top";

/**
 * The tender Programme: one task per QS item, each as long as its slowest resource row needs (hours over the working day, rounded up),
 * linked finish-to-start, with preliminaries running across the whole job. Its length is what the weather allowance and the time-related
 * costs rest on. The Gantt is the full planning tool; this is the tender's own view.
 */
export function Programme({ ws, jobId }: { ws: Workspace; jobId: string }) {
  const model = ws.model!;
  const prog = model.estimate.programme;
  const pkgId = ws.packages.find((p) => p.kind === "programme")?.id ?? "";
  const editable = !!pkgId && ws.canEdit(pkgId);
  const setUp = !("setUp" in prog && prog.setUp === false);
  const result = setUp ? (prog as Extract<typeof prog, { tasks: unknown }>) : null;
  const tasks = model.programme?.tasks ?? [];

  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const api = useRef<GridApi<Row> | null>(null);
  const accepted = useRef(false);

  useEffect(() => {
    if (!adding) return;
    accepted.current = false;
    const t = setTimeout(() => api.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: "code" }), 30);
    return () => clearTimeout(t);
  }, [adding]);
  useEffect(() => {
    if (!justAdded) return;
    const a = api.current;
    const node = a?.getRowNode(justAdded);
    if (!a || !node) return;
    const id = justAdded;
    setJustAdded(null);
    setSelected(id);
    a.ensureNodeVisible(node, "middle");
    setTimeout(() => { const n = a.getRowNode(id); if (n?.rowIndex != null) { a.setFocusedCell(n.rowIndex, "name"); a.startEditingCell({ rowIndex: n.rowIndex, colKey: "name" }); } }, 350);
  });

  const change = (id: string, field: string, value: unknown) => {
    const problem = { text: "" };
    ws.edit(pkgId, `task:${id}`, (b) => { const r = setTaskFieldEdit(b, field, value, tasks); if (!r.ok) { problem.text = r.error; return b; } return r.body; });
    if (problem.text) ws.notify({ kind: "warn", text: problem.text });
  };
  const changeConfig = (field: string, value: unknown) => {
    const problem = { text: "" };
    ws.edit(pkgId, "programme:config", (b: ProgrammeConfig) => { const r = setConfigField(b, field, value); if (!r.ok) { problem.text = r.error; return b; } return r.body; });
    if (problem.text) ws.notify({ kind: "warn", text: problem.text });
  };

  const rows: Row[] = result?.tasks ?? [];
  const field = (f: keyof ProgrammeTaskResult, headerName: string, o: Partial<ColDef<Row>> = {}): ColDef<Row> => ({
    field: f as any, headerName,
    editable: (p) => !isNew(p) && editable,
    cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { change(p.data.id, f === "override" ? "override_days" : String(f), p.newValue); return false; },
    ...o,
  });
  const calc = (f: keyof ProgrammeTaskResult, headerName: string, o: Partial<ColDef<Row>> = {}): ColDef<Row> => ({
    field: f as any, headerName, cellClass: (p) => (isNew(p) ? "cell-new" : "cell-calc"), valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")), ...o,
  });

  const cols: ColDef<Row>[] = [
    {
      field: "code", headerName: "Task", width: 120, editable: (p) => isNew(p) || editable, cellClass: (p) => (isNew(p) ? "cell-new mono" : editable ? "cell-input mono" : "mono"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? "New task code…" : String(p.value ?? "")),
      valueSetter: (p) => {
        if (!isNew({ node: p.node! })) { change(p.data.id, "code", p.newValue); return false; }
        const code = String(p.newValue ?? "").trim();
        if (!code) return false;
        const made = newTask(code, tasks, ws.nextSeq("task"));
        if (!made.ok) { ws.notify({ kind: "warn", text: made.error }); return false; }
        accepted.current = true;
        ws.adopt(pkgId, made.recordId, made.data);
        setAdding(false);
        setJustAdded((made.data.body as { id: string }).id);
        return false;
      },
    },
    field("name", "Description", { flex: 1, minWidth: 240 }),
    calc("qs_code", "QS item", { width: 84, cellClass: (p) => (isNew(p) ? "cell-new mono" : "cell-calc mono") }),
    calc("section", "Section", { width: 150 }),
    calc("derived", "Days from estimate", { width: 100, cellStyle: monoCell, valueFormatter: (p) => (p.node?.rowPinned === "top" || p.value === null ? "" : String(p.value)) }),
    field("override", "Days (override)", { width: 104, cellStyle: monoCell, valueFormatter: (p) => (p.node?.rowPinned === "top" || p.value === null ? "" : String(p.value)) }),
    calc("duration", "Days used", { width: 82, cellStyle: monoCell }),
    {
      field: "predecessors", headerName: "Follows", width: 150, editable: (p) => !isNew(p) && editable, cellClass: (p) => (isNew(p) ? "cell-new mono" : editable ? "cell-input mono" : "cell-locked mono"),
      valueGetter: (p) => (p.data ? p.data.predecessors.join(", ") : ""),
      valueSetter: (p) => { change(p.data.id, "predecessors", p.newValue); return false; },
    },
    {
      field: "hammock", headerName: "Runs the whole job", width: 120, editable: (p) => !isNew(p) && editable, cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
      cellEditor: "agSelectCellEditor", cellEditorParams: { values: ["No", "Yes"] }, valueGetter: (p) => (p.data && !p.data.isNew ? (p.data.hammock ? "Yes" : "No") : ""),
      valueSetter: (p) => { change(p.data.id, "hammock", p.newValue === "Yes"); return false; },
    },
    calc("start", "Start", { width: 118, valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : longDate(p.value)) }),
    calc("finish", "Finish", { width: 118, valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : longDate(p.value)) }),
    calc("float", "Float", { width: 70, cellStyle: monoCell, valueFormatter: (p) => (p.node?.rowPinned === "top" || p.data?.hammock ? "" : String(p.value)) }),
    {
      field: "critical", headerName: "Critical", width: 86, cellClass: (p) => (isNew(p) ? "cell-new" : "cell-calc"),
      cellRenderer: (p: { value?: boolean; node: { rowPinned?: string | null } }) => (p.node.rowPinned !== "top" && p.value ? <span className="badge solid">Critical</span> : null),
    },
    field("basis", "Basis", { flex: 1, minWidth: 160 }),
    field("note", "Note", { flex: 1, minWidth: 160 }),
  ];

  const config = model.programme ? { start: model.programme.start, days_per_week: model.programme.days_per_week, hours_per_day: model.programme.hours_per_day } : null;
  const [startText, setStartText] = useState(config?.start ?? "");
  useEffect(() => setStartText(config?.start ?? ""), [config?.start]);

  const startNow = () => {
    const items = model.qsRows.filter((r) => r.kind === "item").map((r) => ({ code: r.code, description: r.description, amount: r.amount }));
    const s = startFromEstimate(items, new Date().toISOString().slice(0, 10));
    ws.adopt(pkgId, "programme:config", s.config);
    for (const t of s.tasks) ws.adopt(pkgId, t.recordId, t.data);
  };

  const sel = rows.find((r) => r.id === selected);
  const chain = useMemo(() => (result ? result.criticalPath.join("  →  ") : ""), [result]);
  if (!pkgId) return <div className="empty">This job has no programme package yet.</div>;

  if (!result || !config) {
    const missing = (!setUp ? (prog as { missing: { code: string; description: string; amount: number }[] }).missing : []);
    return (
      <>
        <PackageBar ws={ws} pkgId={pkgId} />
        {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
        <div className="page">
          <h4>No programme yet</h4>
          <p className="muted">The programme has one task for each QS item that carries cost, as long as its slowest resource row needs. Start it from the estimate, then link the tasks and set the preliminaries to run across the job.</p>
          <p className="muted">{missing.length} priced QS item{missing.length === 1 ? "" : "s"} would become tasks.</p>
          <button className="btn primary" disabled={!editable} onClick={startNow} title={editable ? "" : "Check the package out first"}>Start the programme from the estimate</button>
        </div>
      </>
    );
  }

  return (
    <>
      <PackageBar ws={ws} pkgId={pkgId}>
        <button className="btn" disabled={!editable || adding} onClick={() => setAdding(true)}>Add task</button>
        <button className="btn" disabled={!editable || !sel} onClick={() => { if (sel) { ws.removeRow(pkgId, `task:${sel.id}`); setSelected(null); } }}>Delete task</button>
        <a className="btn" href={hrefJob(jobId, "gantt")} style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>Open the Gantt</a>
      </PackageBar>
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="prog-strip">
        <label>Start <input className="find" style={{ width: 110 }} value={startText} disabled={!editable} aria-label="Programme start" placeholder="2026-10-05"
          onChange={(e) => setStartText(e.target.value)} onBlur={() => startText !== config.start && changeConfig("start", startText)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></label>
        <label>Days a week <input className="find" style={{ width: 44 }} defaultValue={config.days_per_week} key={`d${config.days_per_week}`} disabled={!editable} aria-label="Days a week" onBlur={(e) => e.target.value !== String(config.days_per_week) && changeConfig("days_per_week", e.target.value)} /></label>
        <label>Hours a day <input className="find" style={{ width: 44 }} defaultValue={config.hours_per_day} key={`h${config.hours_per_day}`} disabled={!editable} aria-label="Hours a day" onBlur={(e) => e.target.value !== String(config.hours_per_day) && changeConfig("hours_per_day", e.target.value)} /></label>
        <span className="sep" />
        <span><strong>{result.duration}</strong> working days</span>
        <span>Finish <strong>{longDate(result.finish)}</strong></span>
      </div>
      {(result.problems.length > 0 || result.missing.length > 0) && (
        <div className="notice warn wrap">
          {result.problems.map((p) => <span key={p}>{p}</span>)}
          {result.missing.length > 0 && <span>Priced QS items with no task: {result.missing.map((m) => `${m.code} (${money(m.amount)})`).join(", ")}</span>}
        </div>
      )}
      <div className="pane" style={{ flex: 1 }}>
        <h3>Tasks <span className="sub">{rows.length} tasks{chain ? ` · critical path: ${chain}` : ""}{adding ? " · type the task code and press Enter" : ""}</span></h3>
        <div className="grid">
          <AgGridReact<Row>
            theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.id} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
            pinnedTopRowData={adding ? [blank()] : []}
            onGridReady={(e) => { api.current = e.api; }}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0]?.id ?? null)}
            onCellEditingStopped={(e) => { if (e.rowPinned === "top" && !accepted.current) setAdding(false); }}
          />
        </div>
      </div>
    </>
  );
}
