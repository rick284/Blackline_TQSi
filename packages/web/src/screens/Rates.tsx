import { AgGridReact } from "ag-grid-react";
import type { ColDef, ColGroupDef, GridApi } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { gridTheme, monoCell } from "../grid.js";
import { api, ApiError } from "../api.js";
import { parseNumberCell } from "../lib/draft.js";
import { libraryBody, toCompanyInput } from "../lib/rateLibrary.js";
import { useCompanyRates } from "../lib/useCompanyRates.js";
import { money, num } from "../lib/fmt.js";
import type { LibraryRow } from "../lib/model.js";
import type { Workspace } from "../workspace.js";
import { LabourBuilder } from "./LabourBuilder.js";
import { PackageBar } from "./PackageBar.js";

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const YES_NO = ["", "Yes", "No"];
const NEW = "__new";

type Row = LibraryRow & { isNew?: boolean };

const blank = (): Row => ({ recordId: NEW, packageId: "", code: "", category: "", description: "", unit: "", baseRate: "", operatorIncluded: "", fuelIncluded: "", source: "", usedBy: 0, cost: null as never, built: false, isNew: true });

/**
 * The Rate Library: every resource rate the estimate prices from, how many build-up rows use it, and the cost those rows carry.
 * Change a rate on a checked-out library and every row that uses it reprices at once. A rate that is in use cannot be deleted, and its
 * code cannot be changed, so nothing can be left pointing at a rate that is gone. "Add rate" opens a new line at the top of the grid with
 * the code cell ready to type in, like a new line in a spreadsheet; once the code is accepted the line joins the library and you carry
 * on across it.
 */
export function Rates({ ws }: { ws: Workspace }) {
  const model = ws.model!;
  const pkgId = ws.libraryPackageId;
  const editable = ws.canEdit(pkgId);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  /** The labour builder, open under the grid: for a new rate (code null) or the build behind a built rate */
  const [builder, setBuilder] = useState<{ code: string | null } | null>(null);
  const { rates: companyRates, reload: reloadCompany } = useCompanyRates();
  const [fromCompany, setFromCompany] = useState("");
  const gridApi = useRef<GridApi<Row> | null>(null);
  const accepted = useRef(false);

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? model.library.filter((r) => [r.code, r.category, r.description, r.source].some((x) => x.toLowerCase().includes(f))) : model.library;
  }, [model.library, filter]);

  // the new line: open its code cell as soon as it appears
  useEffect(() => {
    if (!adding) return;
    accepted.current = false;
    const t = setTimeout(() => gridApi.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: "code" }), 30);
    return () => clearTimeout(t);
  }, [adding]);

  // once the new rate has joined the library, bring it into view and carry on into its description
  useEffect(() => {
    if (!justAdded) return;
    const api = gridApi.current;
    const node = api?.getRowNode(`library:${justAdded}`);
    if (!api || !node) return;
    const code = justAdded;
    setJustAdded(null);
    setSelected(code);
    api.ensureNodeVisible(node, "middle");
    // wait for the grid to finish drawing the new line (and for the code cell's own edit to close) before opening the next cell
    setTimeout(() => {
      const n = api.getRowNode(`library:${code}`);
      if (n?.rowIndex != null) { api.setFocusedCell(n.rowIndex, "description"); api.startEditingCell({ rowIndex: n.rowIndex, colKey: "description" }); }
    }, 350);
  }, [justAdded, model.library]);

  const isNew = (p: { node: { rowPinned?: string | null } }) => p.node.rowPinned === "top";
  const canType = (p: { node: { rowPinned?: string | null } }) => isNew(p) || editable;

  const text = (field: keyof LibraryRow, headerName: string, o: Partial<ColDef<Row>> = {}): ColDef<Row> => ({
    field: field as any, headerName,
    editable: (p) => !isNew(p) && editable,
    cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { ws.edit(p.data.packageId, p.data.recordId, (b) => ({ ...b, [field]: String(p.newValue ?? "").trim() })); return false; }, ...o,
  });

  const cols: (ColDef<Row> | ColGroupDef<Row>)[] = [
    { headerName: "Rate", children: [
      {
        field: "code", headerName: "Code", width: 150, editable: (p) => isNew(p),
        cellClass: (p) => (isNew(p) ? "cell-new mono" : "mono"),
        valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? "New code…" : String(p.value ?? "")),
        valueSetter: (p) => {
          const code = String(p.newValue ?? "").trim();
          if (!code) return false; // left empty: the new line is dropped when editing stops
          if (!CODE.test(code)) { ws.notify({ kind: "warn", text: "A code is letters, numbers, dots and dashes, up to 30 characters, for example LAB-CARP." }); return false; }
          if (model.library.some((r) => r.code.toLowerCase() === code.toLowerCase())) { ws.notify({ kind: "warn", text: `${code} is already in the library.` }); return false; }
          accepted.current = true;
          ws.addRate(pkgId, code);
          setAdding(false);
          setJustAdded(code);
          return false;
        },
      },
      text("category", "Category", { width: 120 }),
      text("description", "Description", { flex: 1, minWidth: 260 }),
      text("unit", "Unit", { width: 70 }),
    ] },
    { headerName: "Cost", children: [
      {
        field: "baseRate", headerName: "Rate", width: 110, cellStyle: monoCell, editable: (p) => !isNew(p) && editable, cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
        valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : num(p.value, 4)),
        valueSetter: (p) => {
          const r = parseNumberCell(p.newValue);
          if (!r.ok || r.value === null) { ws.notify({ kind: "warn", text: "A rate needs a number." }); return false; }
          ws.edit(p.data.packageId, p.data.recordId, (b) => ({ ...b, baseRate: r.value }));
          return false;
        },
      },
      text("operatorIncluded", "Operator in rate", { width: 130, cellEditor: "agSelectCellEditor", cellEditorParams: { values: YES_NO } }),
      text("fuelIncluded", "Fuel in rate", { width: 112, cellEditor: "agSelectCellEditor", cellEditorParams: { values: YES_NO } }),
    ] },
    { headerName: "Evidence", children: [
      { field: "built", headerName: "Build-up", width: 86, cellClass: "cell-calc", valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : p.value ? "Built" : "") },
      text("source", "Source", { flex: 1, minWidth: 200 }),
    ] },
    { headerName: "Use in this estimate", children: [
      { field: "usedBy", headerName: "Rows", width: 76, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")) },
      { field: "cost", headerName: "Cost carried", width: 130, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => (p.data && !p.data.isNew && p.data.usedBy ? money(p.value) : "") },
    ] },
  ];

  const sel = model.library.find((r) => r.code === selected);
  const notHere = companyRates.filter((c) => !model.library.some((r) => r.code.toLowerCase() === c.code.toLowerCase()));

  /** Copy a company rate into this job's library: the job then prices from its own copy. */
  const bringIn = (codes: string[]) => {
    const picked = notHere.filter((c) => codes.includes(c.code));
    if (!picked.length) return;
    ws.batch(pkgId, picked.map((c, i) => ({ recordId: `library:${c.code}`, data: { kind: "library", seq: ws.nextSeq("library") + i, body: libraryBody(c) } })));
    setFromCompany("");
    ws.notify({ kind: "info", text: `${picked.length === 1 ? picked[0]!.code : `${picked.length} rates`} copied into this job's library.` });
  };

  /** Add this job's rates to the company library (codes the company already has are left as they are). */
  const saveToCompany = async (rows: LibraryRow[]) => {
    const input = rows.map(toCompanyInput).filter((r): r is NonNullable<typeof r> => !!r);
    if (!input.length) { ws.notify({ kind: "warn", text: "There is nothing to add." }); return; }
    try {
      const r = await api<{ added: number; skipped: number; invalid?: number }>("POST", "/rates/bulk", { rates: input });
      const left = rows.length - input.length + (r.invalid ?? 0);
      ws.notify({ kind: "info", text: `${r.added} added to the company library${r.skipped ? `; ${r.skipped} already there, left as they are` : ""}${left ? `; ${left} left out (a code or rate that can't be kept)` : ""}.` });
      await reloadCompany();
    } catch (e) { ws.notify({ kind: "warn", text: e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : "Could not save to the company library." }); }
  };
  if (!pkgId) return <div className="empty">This job has no rate library yet.</div>;
  void canType;

  return (
    <>
      <PackageBar ws={ws} pkgId={pkgId}>
        <button className="btn" disabled={!editable || adding} onClick={() => setAdding(true)}>Add rate</button>
        <button className="btn" disabled={!editable || !sel || sel.usedBy > 0 || sel.built} title={sel?.built ? "A built labour rate stays so its build-up is kept" : sel && sel.usedBy > 0 ? "This rate is in use" : ""} onClick={() => { if (sel) { ws.removeRate(sel.packageId, sel.recordId); setSelected(null); } }}>Delete rate</button>
        <button className="btn" disabled={!editable || !!builder} onClick={() => setBuilder({ code: null })} title="Work out a labour rate from what the employer really pays">Build labour rate</button>
        <button className="btn" disabled={!sel?.built || !!builder} onClick={() => sel && setBuilder({ code: sel.code })} title={sel?.built ? "" : "Select a rate made with the labour builder"}>Build-up</button>
        <select value={fromCompany} aria-label="Company library" disabled={!editable || notHere.length === 0} onChange={(e) => setFromCompany(e.target.value)} style={{ height: 24, border: "1px solid var(--line-strong)", borderRadius: 0, background: "var(--paper)", font: "inherit", maxWidth: 200 }}>
          <option value="">{notHere.length === 0 ? "Company library: nothing new" : "From company library…"}</option>
          {notHere.map((c) => <option key={c.id} value={c.code}>{c.code} {c.description}</option>)}
        </select>
        <button className="btn" disabled={!editable || !fromCompany} onClick={() => bringIn([fromCompany])} title="Copy that rate into this job's library">Bring in</button>
        <button className="btn" disabled={!editable || notHere.length === 0} onClick={() => bringIn(notHere.map((c) => c.code))} title="Copy every company rate this job doesn't have">Bring in all</button>
        <button className="btn" disabled={!sel} onClick={() => sel && void saveToCompany([sel])} title="Keep this rate in the company library for other estimates">Save to company</button>
        <button className="btn" disabled={model.library.length === 0} onClick={() => void saveToCompany(model.library)} title="Add all of this job's rates the company library doesn't have yet">Save all to company</button>
        <input className="find" placeholder="Find a rate" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a rate" />
      </PackageBar>
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="pane" style={{ flex: builder ? "3 1 0" : 1 }}>
        <h3>Resource rates <span className="sub">{rows.length === model.library.length ? `${rows.length} rates` : `${rows.length} of ${model.library.length} rates`}{adding ? " · type the new code and press Enter" : ""}</span></h3>
        <div className="grid">
          <AgGridReact<Row>
            theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.recordId} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
            pinnedTopRowData={adding ? [blank()] : []}
            onGridReady={(e) => { gridApi.current = e.api; }}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0]?.code ?? null)}
            onCellEditingStopped={(e) => { if (e.rowPinned === "top" && !accepted.current) setAdding(false); }}
          />
        </div>
      </div>
      {builder && <LabourBuilder key={builder.code ?? "new"} ws={ws} model={model} pkgId={pkgId} code={builder.code} onClose={() => setBuilder(null)} />}
    </>
  );
}
