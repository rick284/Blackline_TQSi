import { AgGridReact } from "ag-grid-react";
import type { ColDef, ColGroupDef } from "ag-grid-community";
import { useMemo, useState } from "react";
import { gridTheme, monoCell } from "../grid.js";
import { parseNumberCell } from "../lib/draft.js";
import { money, num } from "../lib/fmt.js";
import type { LibraryRow } from "../lib/model.js";
import type { Workspace } from "../workspace.js";
import { PackageBar } from "./PackageBar.js";

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
const YES_NO = ["", "Yes", "No"];

/**
 * The Rate Library: every resource rate the estimate prices from, how many build-up rows use it, and the cost those rows carry.
 * Change a rate on a checked-out library and every row that uses it reprices at once, here and in the estimate. A rate that is in use
 * cannot be deleted, and its code cannot be changed, so nothing can be left pointing at a rate that is gone.
 */
export function Rates({ ws }: { ws: Workspace }) {
  const model = ws.model!;
  const pkgId = model.libraryPackageId;
  const editable = ws.canEdit(pkgId);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? model.library.filter((r) => [r.code, r.category, r.description, r.source].some((x) => x.toLowerCase().includes(f))) : model.library;
  }, [model.library, filter]);

  const text = (field: keyof LibraryRow, headerName: string, o: Partial<ColDef<LibraryRow>> = {}): ColDef<LibraryRow> => ({
    field, headerName, editable: () => editable, cellClass: () => (editable ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { ws.edit(p.data.packageId, p.data.recordId, (b) => ({ ...b, [field]: String(p.newValue ?? "").trim() })); return false; }, ...o,
  });

  const cols: (ColDef<LibraryRow> | ColGroupDef<LibraryRow>)[] = [
    { headerName: "Rate", children: [
      { field: "code", headerName: "Code", width: 130, cellClass: "mono" },
      text("category", "Category", { width: 120 }),
      text("description", "Description", { flex: 1, minWidth: 260 }),
      text("unit", "Unit", { width: 70 }),
    ] },
    { headerName: "Cost", children: [
      {
        field: "baseRate", headerName: "Rate", width: 110, cellStyle: monoCell, editable: () => editable, cellClass: () => (editable ? "cell-input" : "cell-locked"),
        valueFormatter: (p) => num(p.value, 4),
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
    { headerName: "Evidence", children: [text("source", "Source", { flex: 1, minWidth: 200 })] },
    { headerName: "Use in this estimate", children: [
      { field: "usedBy", headerName: "Rows", width: 76, cellStyle: monoCell, cellClass: "cell-calc" },
      { field: "cost", headerName: "Cost carried", width: 130, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => (p.data && p.data.usedBy ? money(p.value) : "") },
    ] },
  ];

  const sel = model.library.find((r) => r.code === selected);

  function addRate() {
    const code = window.prompt("Code for the new rate (letters, numbers, dashes), for example LAB-CARP:")?.trim();
    if (!code) return;
    if (!CODE.test(code)) return ws.notify({ kind: "warn", text: "A code is letters, numbers, dots and dashes, up to 30 characters." });
    if (model.library.some((r) => r.code.toLowerCase() === code.toLowerCase())) return ws.notify({ kind: "warn", text: `${code} is already in the library.` });
    ws.addRate(pkgId, code);
    setSelected(code);
  }

  if (!pkgId) return <div className="empty">This job has no rate library yet.</div>;

  return (
    <>
      <PackageBar ws={ws} pkgId={pkgId}>
        <button className="btn" disabled={!editable} onClick={addRate}>Add rate</button>
        <button className="btn" disabled={!editable || !sel || sel.usedBy > 0} title={sel && sel.usedBy > 0 ? "This rate is in use" : ""} onClick={() => { if (sel) { ws.removeRate(sel.packageId, sel.recordId); setSelected(null); } }}>Delete rate</button>
        <input className="find" placeholder="Find a rate" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a rate" />
      </PackageBar>
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="pane" style={{ flex: 1 }}>
        <h3>Resource rates <span className="sub">{rows.length === model.library.length ? `${rows.length} rates` : `${rows.length} of ${model.library.length} rates`}</span></h3>
        <div className="grid">
          <AgGridReact<LibraryRow>
            theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.recordId} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0]?.code ?? null)}
          />
        </div>
      </div>
    </>
  );
}
