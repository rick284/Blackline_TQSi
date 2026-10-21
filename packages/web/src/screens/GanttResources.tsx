import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { gantt as G } from "@blackline/tender/core";
import { gridTheme, monoCell } from "../grid.js";
import { formatDate, formatDuration } from "../lib/gantt.js";
import { RESOURCE_TYPES, formatUnits, newResource, resourceUse, setResourceField } from "../lib/ganttResources.js";
import type { Workspace } from "../workspace.js";

const NEW = -1;
type Row = G.GResource & { n: number; work: string; cost: string; tasks: number; peak: string; over: boolean; isNew?: boolean };
const blank = (): Row => ({ uid: NEW, n: 0, name: "", type: "work", maxUnits: 1, stdRate: "0", initials: "", work: "", cost: "", tasks: 0, peak: "", over: false, isNew: true });
const isNew = (p: { node: { rowPinned?: string | null } }) => p.node.rowPinned === "top";
const money = (n: number) => (n === 0 ? "" : `$${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`);

/**
 * The Resource Sheet: people, plant and material, each with its type, max units and standard rate, and what the plan asks of it: work, cost,
 * how many tasks, the most it is asked for at once, and a flag when that is more than it has (over-allocated). Resources go onto tasks in
 * the Resource Names column or in Task Information.
 */
export function GanttResources({ ws, project, sched, pkgId, editable }: { ws: Workspace; project: G.GProject; sched: G.ScheduleResult; pkgId: string; editable: boolean }) {
  const use = useMemo(() => resourceUse(project, sched), [project, sched]);
  const rows: Row[] = useMemo(() => project.resources.map((r, i) => {
    const u = use.get(r.uid)!;
    return { ...r, n: i + 1, work: u.workMin ? `${Math.round(u.workMin / 6) / 10} hrs` : "", cost: money(u.cost), tasks: u.tasks, peak: r.type === "work" && u.peak ? formatUnits(u.peak) : "", over: u.over };
  }), [project.resources, use]);

  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [justAdded, setJustAdded] = useState<number | null>(null);
  const api = useRef<GridApi<Row> | null>(null);
  const accepted = useRef(false);

  useEffect(() => {
    if (!adding) return;
    accepted.current = false;
    const t = setTimeout(() => api.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: "name" }), 30);
    return () => clearTimeout(t);
  }, [adding]);
  useEffect(() => {
    if (justAdded === null) return;
    const a = api.current;
    const node = a?.getRowNode(String(justAdded));
    if (!a || !node) return;
    const id = justAdded;
    setJustAdded(null);
    setSelected(id);
    a.ensureNodeVisible(node, "middle");
    setTimeout(() => { const n = a.getRowNode(String(id)); if (n?.rowIndex != null) { a.setFocusedCell(n.rowIndex, "stdRate"); a.startEditingCell({ rowIndex: n.rowIndex, colKey: "stdRate" }); } }, 350);
  });

  const change = (uid: number, field: string, value: unknown) => {
    const problem = { text: "" };
    ws.edit(pkgId, `gres:${uid}`, (b: G.GResource) => { const r = setResourceField(b, field, value, project.resources); if (!r.ok) { problem.text = r.error; return b; } return r.body; });
    if (problem.text) ws.notify({ kind: "warn", text: problem.text });
  };
  const field = (f: keyof Row, headerName: string, o: Partial<ColDef<Row>> = {}): ColDef<Row> => ({
    field: f as any, headerName,
    editable: (p) => !isNew(p) && editable,
    cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { change(p.data.uid, String(f), p.newValue); return false; },
    ...o,
  });
  const calc = (f: keyof Row, headerName: string, o: Partial<ColDef<Row>> = {}): ColDef<Row> => ({ field: f as any, headerName, cellClass: (p) => (isNew(p) ? "cell-new" : "cell-calc"), cellStyle: monoCell, ...o });

  const cols: ColDef<Row>[] = [
    { field: "n", headerName: "ID", width: 56, cellClass: (p) => (isNew(p) ? "cell-new" : "cell-calc"), valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value)) },
    {
      field: "name", headerName: "Resource Name", flex: 1, minWidth: 200, editable: (p) => isNew(p) || editable,
      cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? "New resource: its name…" : String(p.value ?? "")),
      valueSetter: (p) => {
        if (!isNew({ node: p.node! })) { change(p.data.uid, "name", p.newValue); return false; }
        const made = newResource(String(p.newValue ?? ""), project.resources);
        if (!String(p.newValue ?? "").trim()) return false;
        if (!made.ok) { ws.notify({ kind: "warn", text: made.error }); return false; }
        accepted.current = true;
        ws.adopt(pkgId, `gres:${made.body.uid}`, { kind: "ganttResource", body: made.body });
        setAdding(false);
        setJustAdded(made.body.uid);
        return false;
      },
    },
    field("type", "Type", { width: 100, cellEditor: "agSelectCellEditor", cellEditorParams: { values: RESOURCE_TYPES.map((t) => t.value) }, valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : RESOURCE_TYPES.find((t) => t.value === p.value)?.label ?? "") }),
    field("initials", "Initials", { width: 80 }),
    field("maxUnits", "Max. Units", { width: 100, cellStyle: monoCell, valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : formatUnits(Number(p.value))), valueGetter: (p) => p.data?.maxUnits }),
    field("stdRate", "Std. Rate", { width: 110, cellStyle: monoCell, valueFormatter: (p) => (p.node?.rowPinned === "top" || !p.data ? "" : `$${Number(p.value).toFixed(2)}${p.data.type === "work" ? "/hr" : ""}`) }),
    calc("work", "Work", { width: 90 }),
    calc("cost", "Cost", { width: 100 }),
    calc("tasks", "Tasks", { width: 70, valueFormatter: (p) => (p.node?.rowPinned === "top" || !p.value ? "" : String(p.value)) }),
    calc("peak", "Peak Units", { width: 96 }),
    {
      field: "over", headerName: "Over-allocated", width: 120, cellClass: (p) => (isNew(p) ? "cell-new" : "cell-calc"),
      cellRenderer: (p: { value?: boolean; node: { rowPinned?: string | null } }) => (p.node.rowPinned !== "top" && p.value ? <span className="badge solid">Over-allocated</span> : null),
    },
  ];

  const sel = project.resources.find((r) => r.uid === selected);
  const assigned = sel ? project.assignments.filter((a) => a.resourceUid === sel.uid).map((a) => ({ a, t: project.tasks.find((t) => t.uid === a.taskUid), s: sched.byUid.get(a.taskUid) })).filter((x) => x.t && x.s) : [];

  const del = () => {
    if (!sel) return;
    const items = [{ recordId: `gres:${sel.uid}`, data: null as null }, ...project.assignments.filter((a) => a.resourceUid === sel.uid).map((a) => ({ recordId: `gasg:${a.uid}`, data: null as null }))];
    const go = () => { ws.batch(pkgId, items); setSelected(null); };
    if (assigned.length) ws.confirm(`Delete ${sel.name}? It is on ${assigned.length} task${assigned.length === 1 ? "" : "s"}, and comes off ${assigned.length === 1 ? "it" : "them"}. You can undo this.`, "Delete resource", go); else go();
  };

  return (
    <div className="gantt-sheet">
      <div className="ribbon-body" style={{ minHeight: 0, padding: "4px 8px" }}>
        <div className="rrow">
          <button className="btn rbtn" disabled={!editable || adding} onClick={() => setAdding(true)}>Add resource</button>
          <button className="btn rbtn" disabled={!editable || !sel} onClick={del}>Delete resource</button>
          <span className="muted" style={{ marginLeft: 12 }}>{project.resources.length} resource{project.resources.length === 1 ? "" : "s"}. A Work resource costs its hours at its rate; a Material or Cost resource costs its quantity at its rate.</span>
        </div>
      </div>
      <div className="pane" style={{ flex: 1 }}>
        <h3>Resource Sheet <span className="sub">{adding ? "type the resource's name and press Enter" : ""}</span></h3>
        <div className="grid">
          <AgGridReact<Row>
            theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => String(p.data.uid)} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
            pinnedTopRowData={adding ? [blank()] : []}
            onGridReady={(e) => { api.current = e.api; }}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0]?.uid ?? null)}
            onCellEditingStopped={(e) => { if (e.rowPinned === "top" && !accepted.current) setAdding(false); }}
            noRowsOverlayComponent={() => <span className="muted">No resources yet. Add one, then put it on tasks in the Resource Names column.</span>}
          />
        </div>
      </div>
      <div className="pane" style={{ flex: "0 0 30%" }}>
        <h3>{sel ? `${sel.name} is on` : "Pick a resource to see its tasks"}{sel ? <span className="sub">{assigned.length} task{assigned.length === 1 ? "" : "s"}</span> : null}</h3>
        <div style={{ overflow: "auto", flex: 1 }}>
          {sel && assigned.length > 0 && (
            <table className="plain">
              <thead><tr><th>ID</th><th>Task</th><th>Start</th><th>Finish</th><th className="r">Units</th><th className="r">Work</th></tr></thead>
              <tbody>
                {assigned.map(({ a, t, s }) => (
                  <tr key={a.uid}>
                    <td className="num">{s!.id}</td><td>{t!.name}</td><td>{formatDate(s!.start)}</td><td>{formatDate(s!.finish)}</td>
                    <td className="r num">{sel.type === "material" || sel.type === "cost" ? a.units : formatUnits(a.units)}</td>
                    <td className="r num">{sel.type === "work" ? formatDuration(Math.round(s!.durationMin * a.units), project.minutesPerDay) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {sel && assigned.length === 0 && <div className="empty">Not on any task yet.</div>}
        </div>
      </div>
    </div>
  );
}
