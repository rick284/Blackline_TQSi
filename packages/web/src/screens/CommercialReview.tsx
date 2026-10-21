import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { D } from "@blackline/engine";
import { methodsFor } from "@blackline/tender/core";
import { gridTheme, monoCell } from "../grid.js";
import { canDeleteLine, editableFields, isPercent, newAllowance, newOverlay, parseOverlap, setCaField, setOverlayField, type CaBody, type OverlayBody } from "../lib/commercial.js";
import { money } from "../lib/fmt.js";
import type { Workspace } from "../workspace.js";
import { PackageBar } from "./PackageBar.js";
import { PriceStack } from "./PriceStack.js";

const NEW = "__new";
const ENGINE = ["Risk Engine", "Weather Engine", "Management Reserve"];
type CaRow = CaBody & { isNew?: boolean; engine: string; amount: string };
type SubRow = OverlayBody & { isNew?: boolean };

const blankLine = (): CaRow => ({ ref: NEW, name: "", method: "PC Sum", include: "Yes", pct: "", pcSum: "", engine: "", amount: "", isNew: true });
const blankSub = (): SubRow => ({ name: "", amount: "", kind: "", isNew: true });
const isNew = (p: { node: { rowPinned?: string | null } }) => p.node.rowPinned === "top";

/**
 * Commercial Review: the lines that turn the direct cost into the tender (risk, weather, reserve, allowances, overhead, profit, bonds, GST),
 * the subcontract packages that join the own-works price, and the price they make. Change a line and the whole price moves at once, as
 * the engine works it out on this computer. Standard lines are switched in or out of the price, never deleted; allowances you add (CX01...)
 * can be deleted. A margin of 100% or more is refused, because it has no price.
 */
export function CommercialReview({ ws }: { ws: Workspace }) {
  const model = ws.model!;
  const t = model.estimate.tender;
  const comPkg = ws.packages.find((p) => p.kind === "commercial")?.id ?? "";
  const subPkg = ws.packages.find((p) => p.kind === "subcontracts")?.id ?? "";
  const comEditable = !!comPkg && ws.canEdit(comPkg);
  const subEditable = !!subPkg && ws.canEdit(subPkg);

  const [selected, setSelected] = useState<string | null>(null);
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const [addingLine, setAddingLine] = useState(false);
  const [addingSub, setAddingSub] = useState(false);
  const [justLine, setJustLine] = useState<string | null>(null);
  const [justSub, setJustSub] = useState<string | null>(null);
  const lineApi = useRef<GridApi<CaRow> | null>(null);
  const subApi = useRef<GridApi<SubRow> | null>(null);
  const lineAccepted = useRef(false);
  const subAccepted = useRef(false);

  const engineRefs = useMemo(() => new Map(model.estimate.commercial.map((c) => [c.ref, c])), [model.estimate]);
  const amountOf = (ref: string) => (ref === "CA17" ? t.overhead : ref === "CA18" ? t.profit : ref === "CA19" ? t.bonds : ref === "CA20" ? t.retentionFinance
    : ref === "CA21" ? t.gst : ref === "CA22" ? t.retentionWithheld : t.additions.get(ref));
  const rows: CaRow[] = useMemo(() => model.commercial.map((c) => {
    const body = c as CaBody;
    const fromEngine = ENGINE.includes(c.method) || (c.ref === "CA16" && model.reserveLinked);
    const ev = engineRefs.get(c.ref)?.engineValue;
    const amt = c.include === "Yes" ? amountOf(c.ref) : undefined;
    return { ...body, engine: fromEngine && ev !== undefined ? money(ev) : "", amount: amt === undefined ? "" : money(amt) };
  }), [model, engineRefs]); // eslint-disable-line react-hooks/exhaustive-deps

  // a new line opens in its first cell, and moves on across the row once it exists
  useEffect(() => {
    if (!addingLine) return;
    lineAccepted.current = false;
    const timer = setTimeout(() => lineApi.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: "name" }), 30);
    return () => clearTimeout(timer);
  }, [addingLine]);
  useEffect(() => {
    if (!addingSub) return;
    subAccepted.current = false;
    const timer = setTimeout(() => subApi.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: "name" }), 30);
    return () => clearTimeout(timer);
  }, [addingSub]);
  useEffect(() => {
    if (!justLine) return;
    const api = lineApi.current;
    const node = api?.getRowNode(justLine);
    if (!api || !node) return;
    const ref = justLine;
    setJustLine(null);
    setSelected(ref);
    api.ensureNodeVisible(node, "middle");
    setTimeout(() => { const n = api.getRowNode(ref); if (n?.rowIndex != null) { api.setFocusedCell(n.rowIndex, "pcSum"); api.startEditingCell({ rowIndex: n.rowIndex, colKey: "pcSum" }); } }, 350);
  });
  useEffect(() => {
    if (!justSub) return;
    const api = subApi.current;
    const node = api?.getRowNode(justSub);
    if (!api || !node) return;
    const id = justSub;
    setJustSub(null);
    setSelectedSub(id);
    api.ensureNodeVisible(node, "middle");
    setTimeout(() => { const n = api.getRowNode(id); if (n?.rowIndex != null) { api.setFocusedCell(n.rowIndex, "amount"); api.startEditingCell({ rowIndex: n.rowIndex, colKey: "amount" }); } }, 350);
  });

  /** Change one field of a line through the shared rules; what is wrong is said in the page and nothing changes. */
  const changeLine = (ref: string, field: string, value: unknown) => {
    const problem = { text: "" };
    ws.edit(comPkg, `ca:${ref}`, (b: CaBody) => { const r = setCaField(b, field, value, model.reserveLinked); if (!r.ok) { problem.text = r.error; return b; } return r.body; });
    if (problem.text) ws.notify({ kind: "warn", text: problem.text });
  };
  const changeSub = (name: string, field: string, value: unknown) => {
    const problem = { text: "" };
    ws.edit(subPkg, `overlay:${name}`, (b: OverlayBody) => { const r = setOverlayField(b, field, value); if (!r.ok) { problem.text = r.error; return b; } return r.body; });
    if (problem.text) ws.notify({ kind: "warn", text: problem.text });
  };

  const can = (r: CaRow | undefined, f: "include" | "name" | "method" | "pct" | "pcSum") => !!r && !r.isNew && comEditable && editableFields(r, model.reserveLinked)[f];
  const cls = (f: "include" | "name" | "method" | "pct" | "pcSum") => (p: { data?: CaRow; node: { rowPinned?: string | null } }) =>
    isNew(p) ? "cell-new" : !comEditable ? "cell-locked" : can(p.data, f) ? "cell-input" : "cell-calc";
  const percentText = (r: CaRow) => (r.ref === "CA23" ? String(r.pct ?? "") : r.pct === null || r.pct === undefined || r.pct === "" ? "" : new D(String(r.pct)).times(100).toString());

  const lineCols: ColDef<CaRow>[] = [
    { field: "ref", headerName: "Line", width: 74, cellClass: (p) => (isNew(p) ? "cell-new mono" : "cell-calc mono"), valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")) },
    {
      field: "name", headerName: "Description", flex: 1, minWidth: 260, tooltipField: "name",
      editable: (p) => isNew(p) || can(p.data, "name"), cellClass: cls("name"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? "New allowance: what it covers…" : String(p.value ?? "")),
      valueSetter: (p) => {
        if (!isNew({ node: p.node! })) { changeLine(p.data.ref, "name", p.newValue); return false; }
        const name = String(p.newValue ?? "").trim();
        if (!name) return false;
        const made = newAllowance(name, model.commercial.map((c) => c.ref), ws.nextSeq("ca"));
        if (!made.ok) { ws.notify({ kind: "warn", text: made.error }); return false; }
        lineAccepted.current = true;
        ws.adopt(comPkg, made.recordId, made.data);
        setAddingLine(false);
        setJustLine((made.data.body as CaBody).ref);
        return false;
      },
    },
    {
      field: "include", headerName: "In price", width: 82, editable: (p) => can(p.data, "include"), cellClass: cls("include"),
      cellEditor: "agSelectCellEditor", cellEditorParams: { values: ["Yes", "No"] }, valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")),
      valueSetter: (p) => { changeLine(p.data.ref, "include", p.newValue); return false; },
    },
    {
      field: "method", headerName: "Worked out as", width: 140, editable: (p) => can(p.data, "method"), cellClass: cls("method"),
      cellEditor: "agSelectCellEditor", cellEditorParams: (p: { data?: CaRow }) => ({ values: methodsFor(p.data?.ref ?? "") }),
      valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")),
      valueSetter: (p) => { changeLine(p.data.ref, "method", p.newValue); return false; },
    },
    {
      colId: "pct", headerName: "Rate", width: 86, cellStyle: monoCell, editable: (p) => can(p.data, "pct"), cellClass: cls("pct"),
      valueGetter: (p) => (p.data && !p.data.isNew ? percentText(p.data) : ""),
      valueFormatter: (p) => (!p.data || p.data.isNew || !editableFields(p.data, model.reserveLinked).pct || p.value === "" ? "" : isPercent(p.data) ? `${p.value}%` : String(p.value)),
      valueSetter: (p) => { changeLine(p.data.ref, "pct", p.newValue); return false; },
    },
    {
      field: "pcSum", headerName: "Fixed sum", width: 110, cellStyle: monoCell, editable: (p) => can(p.data, "pcSum"), cellClass: cls("pcSum"),
      valueFormatter: (p) => (!p.data || p.data.isNew || !editableFields(p.data, model.reserveLinked).pcSum || p.value === "" || p.value === null ? "" : money(p.value)),
      valueSetter: (p) => { changeLine(p.data.ref, "pcSum", p.newValue); return false; },
    },
    { field: "engine", headerName: "From engine", width: 112, cellStyle: monoCell, cellClass: "cell-calc", tooltipValueGetter: () => "Risk Truth, Weather and the Management Reserve feed these lines" },
    { field: "amount", headerName: "In the price", width: 116, cellStyle: monoCell, cellClass: "cell-calc" },
    {
      field: "note", headerName: "Note", flex: 1, minWidth: 180,
      editable: (p) => !!p.data && !p.data.isNew && comEditable, cellClass: (p) => (isNew(p) ? "cell-new" : comEditable ? "cell-input" : "cell-locked"),
      valueSetter: (p) => { changeLine(p.data.ref, "note", p.newValue); return false; },
    },
  ];

  const subRows: SubRow[] = model.overlays as SubRow[];
  const subCols: ColDef<SubRow>[] = [
    {
      field: "name", headerName: "Subcontract package", flex: 1, minWidth: 240,
      editable: (p) => isNew(p), cellClass: (p) => (isNew(p) ? "cell-new" : "cell-calc"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? "New package: its name…" : String(p.value ?? "")),
      valueSetter: (p) => {
        if (!isNew({ node: p.node! })) return false;
        const name = String(p.newValue ?? "").trim();
        if (!name) return false;
        const made = newOverlay(name, subRows.map((o) => o.name), ws.nextSeq("overlay"));
        if (!made.ok) { ws.notify({ kind: "warn", text: made.error }); return false; }
        subAccepted.current = true;
        ws.adopt(subPkg, made.recordId, made.data);
        setAddingSub(false);
        setJustSub(`overlay:${name.trim()}`);
        return false;
      },
    },
    {
      field: "kind", headerName: "Basis", width: 190, editable: (p) => !isNew(p) && subEditable, cellClass: (p) => (isNew(p) ? "cell-new" : subEditable ? "cell-input" : "cell-locked"),
      valueSetter: (p) => { changeSub(p.data.name, "kind", p.newValue); return false; },
    },
    {
      field: "amount", headerName: "Amount", width: 130, cellStyle: monoCell, editable: (p) => !isNew(p) && subEditable, cellClass: (p) => (isNew(p) ? "cell-new" : subEditable ? "cell-input" : "cell-locked"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" || p.value === "" ? "" : money(p.value)),
      valueSetter: (p) => { changeSub(p.data.name, "amount", p.newValue); return false; },
    },
  ];

  // the confirmed overlap belongs to the Commercial package
  const [overlapText, setOverlapText] = useState(model.overlap);
  useEffect(() => setOverlapText(model.overlap), [model.overlap]);
  const commitOverlap = () => {
    if (overlapText.trim() === model.overlap) return;
    const r = parseOverlap(overlapText);
    if (!r.ok) { ws.notify({ kind: "warn", text: r.error }); setOverlapText(model.overlap); return; }
    ws.edit(comPkg, "setting:overlap", () => r.value);
  };

  const sel = rows.find((r) => r.ref === selected);
  if (!comPkg) return <div className="empty">This job has no commercial package yet.</div>;

  return (
    <>
      <PackageBar ws={ws} pkgId={comPkg}>
        <button className="btn" disabled={!comEditable || addingLine} onClick={() => setAddingLine(true)} title="An allowance of your own, in the price before overhead and profit">Add allowance</button>
        <button className="btn" disabled={!comEditable || !sel || !canDeleteLine(sel.ref)} title={sel && !canDeleteLine(sel.ref) ? "A standard line is switched out of the price, not deleted" : ""}
          onClick={() => { if (sel) { ws.removeRow(comPkg, `ca:${sel.ref}`); setSelected(null); } }}>Delete allowance</button>
      </PackageBar>
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="review">
        <div className="review-main">
          <div className="pane" style={{ flex: "3 1 0" }}>
            <h3>Commercial lines <span className="sub">{rows.length} lines{addingLine ? " · type what the allowance covers and press Enter" : ""}</span></h3>
            <div className="grid">
              <AgGridReact<CaRow>
                theme={gridTheme} rowData={rows} columnDefs={lineCols} getRowId={(p) => p.data.ref} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
                pinnedTopRowData={addingLine ? [blankLine()] : []}
                onGridReady={(e) => { lineApi.current = e.api; }}
                rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
                onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0]?.ref ?? null)}
                onCellEditingStopped={(e) => { if (e.rowPinned === "top" && !lineAccepted.current) setAddingLine(false); }}
              />
            </div>
          </div>
          {subPkg && (
            <>
              <PackageBar ws={ws} pkgId={subPkg} bare>
                <button className="btn" disabled={!subEditable || addingSub} onClick={() => setAddingSub(true)}>Add package</button>
                <button className="btn" disabled={!subEditable || !selectedSub} onClick={() => { if (selectedSub) { ws.removeRow(subPkg, selectedSub); setSelectedSub(null); } }}>Delete package</button>
              </PackageBar>
              <div className="pane" style={{ flex: "2 1 0" }}>
                <h3>
                  Subcontract packages <span className="sub">{subRows.length} packages · added once to the own-works price</span>
                  <label style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
                    Confirmed overlap $
                    <input
                      className="find" style={{ width: 110, textAlign: "right" }} value={overlapText} disabled={!comEditable} inputMode="decimal" aria-label="Confirmed overlap"
                      onChange={(e) => setOverlapText(e.target.value)} onBlur={commitOverlap} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      title={comEditable ? "Cost counted in both own works and a subcontract package" : "Check the Commercial package out to change this"}
                    />
                  </label>
                </h3>
                <div className="grid">
                  <AgGridReact<SubRow>
                    theme={gridTheme} rowData={subRows} columnDefs={subCols} getRowId={(p) => `overlay:${p.data.name}`} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
                    pinnedTopRowData={addingSub ? [blankSub()] : []}
                    onGridReady={(e) => { subApi.current = e.api; }}
                    rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
                    onSelectionChanged={(e) => { const r = e.api.getSelectedRows()[0]; setSelectedSub(r ? `overlay:${r.name}` : null); }}
                    onCellEditingStopped={(e) => { if (e.rowPinned === "top" && !subAccepted.current) setAddingSub(false); }}
                  />
                </div>
              </div>
            </>
          )}
        </div>
        <aside className="review-side" aria-label="The price">
          <h3>The price <span className="sub">worked out on this computer</span></h3>
          <div className="page"><PriceStack model={model} /></div>
        </aside>
      </div>
    </>
  );
}
