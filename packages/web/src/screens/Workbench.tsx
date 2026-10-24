import { AgGridReact } from "ag-grid-react";
import type { ColDef, ColGroupDef, GridApi, RowClassParams } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { D } from "@blackline/engine";
import { api, ApiError } from "../api.js";
import { useSession } from "../session.js";
import { gridTheme, monoCell } from "../grid.js";
import { parseNumberCell } from "../lib/draft.js";
import { money, num } from "../lib/fmt.js";
import { isBlocking, total, type BuildupRow, type QsRow } from "../lib/model.js";
import { newQsItem, qsDeletion } from "../lib/qs.js";
import { libraryBody, pickList, typeOfCategory } from "../lib/rateLibrary.js";
import { useCompanyRates } from "../lib/useCompanyRates.js";
import { NewResource } from "./NewResource.js";
import { PackageBar } from "./PackageBar.js";
import { RateEditor } from "./RateEditor.js";
import { StartTender } from "./StartTender.js";
import type { Workspace } from "../workspace.js";

const MODES = ["Time x Count", "QS Qty x Factor", "Direct Qty", "Lump Sum / Quote"];
const RESOURCE_TYPES = ["Labour", "Plant", "Material", "Subcontract", "Other"];

interface QsData extends QsRow { holder: string; isNew?: boolean }
const NEW_KEY = "__new";
const blankQs = (section: string): QsData => ({ kind: "item", key: NEW_KEY, code: "", section, description: "", unit: "", quantity: "", amount: null as never, rate: null, rows: 0, flags: 0, recordId: "", packageId: "", holder: "", isNew: true });
interface RowData {
  recordId: string; packageId: string; rowId: string; task: string; resourceType: string; resourceCode: string; resource: string; mode: string;
  productivityRate: string; durationOverrideHrs: string; count: string; manualQty: string; utilisation: string; waste: string; jobRateOverride: string;
  hours: string; appliedRate: string; cost: string; verified: string; qa: string;
}

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

function rowData(r: BuildupRow): RowData {
  const b = r.src;
  return {
    recordId: r.recordId, packageId: r.packageId, rowId: r.rowId, task: s(b.task), resourceType: s(b.resourceType), resourceCode: s(b.resourceCode), resource: r.resource,
    mode: s(b.mode), productivityRate: s(b.productivityRate), durationOverrideHrs: s(b.durationOverrideHrs), count: s(b.count), manualQty: s(b.manualQty),
    utilisation: s(b.utilisation), waste: s(b.waste), jobRateOverride: s(b.jobRateOverride), hours: r.res.appliedDurationHrs.toString(),
    appliedRate: r.res.appliedRate.toString(), cost: r.res.cost.toString(), verified: s(b.verified), qa: r.res.qaFlag,
  };
}

/**
 * The estimate workbench: QS takeoff above, the selected item's resource build-up below. White cells are inputs, shaded cells are
 * calculated. Inputs are editable only on a package you have checked out; every edit recalculates the whole job on this computer.
 */
export function Workbench({ ws }: { ws: Workspace }) {
  const { session } = useSession();
  const model = ws.model!;
  const items = model.qsRows.filter((r) => r.kind === "item");
  const [selectedQs, setSelectedQs] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const qsApi = useRef<GridApi<QsData> | null>(null);
  // a new takeoff line: pinned at the top with its code cell open, like a new line in a spreadsheet
  const [addingItem, setAddingItem] = useState(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // which section a new item goes into (null = the selected item's own), and the new-section control
  const [addTarget, setAddTarget] = useState<string | null>(null);
  const [newSection, setNewSection] = useState<{ open: boolean; name: string }>({ open: false, name: "" });
  const accepted = useRef(false);
  // the company resource library, and the panel for a resource that is in neither library yet
  const { rates: companyRates, reload: reloadRates } = useCompanyRates();
  const [showNew, setShowNew] = useState(false);
  useEffect(() => {
    if (!addingItem) return;
    accepted.current = false;
    const t = setTimeout(() => qsApi.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: "code" }), 30);
    return () => clearTimeout(t);
  }, [addingItem]);
  useEffect(() => {
    if (!justAdded) return;
    const api = qsApi.current;
    const node = api?.getRowNode(`q:${justAdded}`);
    if (!api || !node) return;
    const code = justAdded;
    setJustAdded(null);
    setSelectedQs(code);
    api.ensureNodeVisible(node, "middle");
    setTimeout(() => {
      const n = api.getRowNode(`q:${code}`);
      if (n?.rowIndex != null) { api.setFocusedCell(n.rowIndex, "description"); api.startEditingCell({ rowIndex: n.rowIndex, colKey: "description" }); }
    }, 350);
  });

  useEffect(() => { if (!selectedQs || !items.some((i) => i.code === selectedQs)) setSelectedQs(items[0]?.code ?? null); }, [items, selectedQs]);
  // keep the grid's own selection on the chosen item, including after the rows are rebuilt by an edit
  useEffect(() => {
    qsApi.current?.forEachNode((n) => n.setSelected(n.data?.kind === "item" && n.data.code === selectedQs));
  }, [selectedQs, model]);

  const pkgId = selectedQs ? model.packageOfQs.get(selectedQs) ?? "" : "";
  const editable = ws.canEdit(pkgId);
  const sections = ws.packages.filter((p) => p.kind === "qs-section" && p.name !== "Unassigned rows");
  const targetPkg = addTarget && sections.some((x) => x.id === addTarget) ? addTarget : pkgId || sections[0]?.id || "";
  const targetSection = ws.pkg(targetPkg)?.name ?? "";
  const canAdd = !!targetPkg && ws.canEdit(targetPkg);

  const qsRows: QsData[] = useMemo(
    () => {
      const rows = model.qsRows.map((r) => {
        const p = ws.pkg(r.packageId);
        return { ...r, holder: p?.lock ? (ws.isMine(r.packageId) ? "You" : p.lock.holder_name) : "" };
      });
      // a section with nothing in it yet still shows, so a new section can be seen (and held) before its first item
      const shown = new Set(rows.filter((r) => r.kind === "section").map((r) => r.section));
      for (const sec of ws.packages.filter((p) => p.kind === "qs-section" && p.name !== "Unassigned rows" && !shown.has(p.name))) {
        rows.push({ kind: "section", key: `s:${sec.name}`, code: "", section: sec.name, description: sec.name, unit: "", quantity: "", amount: new D(0), rate: null, rows: 0, flags: 0, recordId: "", packageId: sec.id,
          holder: sec.lock ? (ws.isMine(sec.id) ? "You" : sec.lock.holder_name) : "" });
      }
      return rows;
    },
    [model, ws.packages], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const addSection = async () => {
    try {
      const r = await api<{ packageId: string; name: string }>("POST", `/jobs/${ws.jobId}/sections`, { name: newSection.name });
      await ws.load();
      setNewSection({ open: false, name: "" });
      setAddTarget(r.packageId);
      ws.checkOut(r.packageId);
    } catch (e) { ws.notify({ kind: "warn", text: e instanceof ApiError ? e.message : "The section could not be added." }); }
  };
  const libId = ws.libraryPackageId;
  const picks = useMemo(() => pickList(model.library, companyRates), [model.library, companyRates]);

  /**
   * Put a library code on a build-up row. A rate the job already has is just named; one that only the company library has is copied into the job's
   * Rate Library in the same step (one undo), which needs that package checked out. A code that is in neither is kept as typed and flagged.
   */
  const applyPick = (row: RowData, typed: string) => {
    const code = typed.trim();
    const rec = ws.record(row.recordId);
    if (!rec) return false;
    const pick = picks.find((p) => p.code.toLowerCase() === code.toLowerCase());
    const useCode = pick?.code ?? code;
    const type = pick ? typeOfCategory(pick.category) : null;
    const body = { ...(rec.body as object), resourceCode: useCode, ...(type ? { resourceType: type } : {}) };
    if (pick?.fromCompany) {
      const c = companyRates.find((x) => x.code.toLowerCase() === useCode.toLowerCase());
      if (!c) return false;
      if (!libId || !ws.canEdit(libId)) { ws.notify({ kind: "warn", text: `${c.code} is in the company library. Check out this job's Rate Library (the second bar) to bring it in, then pick it again.` }); return false; }
      ws.batchMulti([
        { packageId: libId, recordId: `library:${c.code}`, data: { kind: "library", seq: ws.nextSeq("library"), body: libraryBody(c) } },
        { packageId: row.packageId, recordId: row.recordId, data: { ...rec, body } },
      ]);
      ws.notify({ kind: "info", text: `${c.code} copied into this job's Rate Library at ${num(c.baseRate, 4)}.` });
      return false;
    }
    ws.edit(row.packageId, row.recordId, () => body);
    return false;
  };
  const buildRows = useMemo(() => (selectedQs ? (model.buildups.get(selectedQs) ?? []).map(rowData) : []), [model, selectedQs]);
  const selectedBuildRow = buildRows.find((x) => x.rowId === selectedRow) ?? null;

  const textQs = (field: "description" | "unit", headerName: string, o: Partial<ColDef<QsData>> = {}): ColDef<QsData> => ({
    field, headerName,
    editable: (p) => p.data?.kind === "item" && !p.data.isNew && ws.canEdit(p.data.packageId),
    cellClass: (p) => (p.data?.isNew ? "cell-new" : p.data?.kind === "item" ? (ws.canEdit(p.data.packageId) ? "cell-input" : "cell-locked") : ""),
    valueSetter: (p) => { if (!p.data?.isNew) ws.edit(p.data.packageId, p.data.recordId, (b) => ({ ...b, [field]: s(p.newValue).trim() })); return false; },
    ...o,
  });

  const qsCols: (ColDef<QsData> | ColGroupDef<QsData>)[] = [
    { headerName: "Item", children: [
      {
        field: "code", headerName: "Code", width: 84, editable: (p) => !!p.data?.isNew, cellClass: (p) => (p.data?.isNew ? "cell-new mono" : "mono"),
        valueFormatter: (p) => (p.data?.isNew && !p.value ? "New code…" : String(p.value ?? "")),
        valueSetter: (p) => {
          if (!p.data?.isNew) return false;
          const code = String(p.newValue ?? "").trim();
          if (!code) return false; // left empty: the new line is dropped when editing stops
          const made = newQsItem(code, targetSection, items.map((i) => i.code), ws.nextSeq("qs"));
          if (!made.ok) { ws.notify({ kind: "warn", text: made.error }); return false; }
          accepted.current = true;
          ws.adopt(targetPkg, made.recordId, made.data);
          setAddingItem(false);
          setJustAdded(code);
          return false;
        },
      },
      textQs("description", "Description", { flex: 1, minWidth: 220 }),
      textQs("unit", "Unit", { width: 62 }),
    ] },
    { headerName: "Quantity", children: [
      {
        field: "quantity", headerName: "Qty", width: 110, cellStyle: monoCell,
        editable: (p) => p.data?.kind === "item" && ws.canEdit(p.data.packageId),
        cellClass: (p) => (p.data?.kind === "item" ? (ws.canEdit(p.data.packageId) ? "cell-input" : "cell-locked") : ""),
        valueFormatter: (p) => (p.data?.kind === "item" ? num(p.value) : ""),
        valueSetter: (p) => {
          const r = parseNumberCell(p.newValue);
          if (!r.ok || r.value === null) { ws.notify({ kind: "warn", text: "A quantity needs a number." }); return false; }
          ws.edit(p.data.packageId, p.data.recordId, (b) => ({ ...b, quantity: r.value }));
          return false;
        },
      },
    ] },
    { headerName: "Direct cost", children: [
      { field: "amount", headerName: "Amount", width: 124, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => money(p.value) },
      { field: "rate", headerName: "Rate", width: 104, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => (p.data?.kind === "item" ? money(p.value, 2) : "") },
    ] },
    { headerName: "Control", children: [
      { field: "rows", headerName: "Rows", width: 62, cellStyle: monoCell, valueFormatter: (p) => (p.data?.kind === "item" ? String(p.value) : "") },
      { field: "flags", headerName: "Flags", width: 66, cellStyle: monoCell, valueFormatter: (p) => (p.data?.kind === "item" && p.value ? String(p.value) : "") },
      { field: "holder", headerName: "Held by", width: 110 },
    ] },
  ];

  const numCol = (field: keyof RowData, headerName: string, width = 92): ColDef<RowData> => ({
    field, headerName, width, cellStyle: monoCell, editable: () => editable, cellClass: () => (editable ? "cell-input" : "cell-locked"),
    valueFormatter: (p) => num(p.value, 4),
    valueSetter: (p) => {
      const r = parseNumberCell(p.newValue);
      if (!r.ok) { ws.notify({ kind: "warn", text: `${p.colDef.headerName} needs a number.` }); return false; }
      ws.edit(p.data.packageId, p.data.recordId, (b) => ({ ...b, [field]: r.value }));
      return false;
    },
  });

  const textCol = (field: keyof RowData, headerName: string, o: Partial<ColDef<RowData>> = {}): ColDef<RowData> => ({
    field, headerName, editable: () => editable, cellClass: () => (editable ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { ws.edit(p.data.packageId, p.data.recordId, (b) => ({ ...b, [field]: s(p.newValue).trim() })); return false; }, ...o,
  });

  const buildCols: (ColDef<RowData> | ColGroupDef<RowData>)[] = [
    { headerName: "Row", children: [
      { field: "rowId", headerName: "ID", width: 100, cellClass: "mono" },
      textCol("task", "Task", { flex: 1, minWidth: 150 }),
      textCol("resourceType", "Type", { width: 104, cellEditor: "agSelectCellEditor", cellEditorParams: { values: RESOURCE_TYPES } }),
      textCol("resourceCode", "Resource", {
        width: 120, cellClass: (p) => (editable ? "cell-input mono" : "mono"), cellEditor: RateEditor, cellEditorPopup: true, cellEditorParams: { picks },
        suppressKeyboardEvent: (p) => p.editing && ["Enter", "Tab", "ArrowUp", "ArrowDown"].includes(p.event.key),
        valueSetter: (p) => applyPick(p.data, String(p.newValue ?? "")),
      }),
      {
        field: "resource", headerName: "Description", flex: 1, minWidth: 180, editable: () => editable, cellClass: () => (editable ? "cell-input" : "cell-locked"),
        valueSetter: (p) => {
          // the row's own words; typing what the library already says (or nothing) goes back to following the library
          const typed = s(p.newValue).trim();
          const own = model.library.find((l) => l.code === p.data.resourceCode)?.description ?? "";
          ws.edit(p.data.packageId, p.data.recordId, (b) => ({ ...b, description: typed === own ? "" : typed }));
          return false;
        },
      },
    ] },
    { headerName: "Method", children: [textCol("mode", "Calculation", { width: 140, cellEditor: "agSelectCellEditor", cellEditorParams: { values: MODES } })] },
    { headerName: "Inputs", children: [
      numCol("productivityRate", "Productivity"), numCol("durationOverrideHrs", "Hours override", 116), numCol("count", "Count", 76), numCol("manualQty", "Manual qty"),
      numCol("utilisation", "Utilisation", 86), numCol("waste", "Waste", 72), numCol("jobRateOverride", "Job rate"),
    ] },
    { headerName: "Calculated", children: [
      { field: "hours", headerName: "Hours", width: 84, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => num(p.value, 2) },
      { field: "appliedRate", headerName: "Rate", width: 90, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => money(p.value) },
      { field: "cost", headerName: "Cost", width: 114, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => money(p.value) },
    ] },
    { headerName: "Control", children: [
      textCol("verified", "Verified", { width: 86, cellEditor: "agSelectCellEditor", cellEditorParams: { values: ["Yes", "No"] } }),
      {
        field: "qa", headerName: "Check", width: 170, cellClass: "cell-calc",
        cellRenderer: (p: { value?: string }) => (p.value ? <span className={`badge ${p.value === "OK" ? "" : isBlocking(p.value) ? "solid" : "grey"}`}>{p.value}</span> : null),
      },
    ] },
  ];

  /** Delete the selected takeoff item with its build-up rows; asks first when there are rows, and one undo puts it all back. */
  const deleteItem = () => {
    const del = selectedQs ? qsDeletion(model, selectedQs) : null;
    if (!del || !selectedQs) return;
    const code = selectedQs;
    const go = () => { ws.removeMany(del.records); setSelectedRow(null); };
    if (del.rows === 0) go();
    else ws.confirm(`Delete ${code} and its ${del.rows} build-up row${del.rows === 1 ? "" : "s"}? You can undo this.`, "Delete item", go);
  };

  const orphan = model.orphanCost.gt(0);
  const totalRow: QsData[] = [{ kind: "section", key: "total", code: "", section: "", description: "Total direct cost", unit: "", quantity: "", amount: total(model.qsRows), rate: null, rows: 0, flags: 0, recordId: "", packageId: "", holder: "" }];
  const rowClass = (p: RowClassParams<QsData>) => (p.data?.key === "total" ? "row-total" : p.data?.kind === "section" ? "row-section" : "");

  if (ws.packages.length === 0) return <StartTender ws={ws} />;

  return (
    <>
      <PackageBar ws={ws} pkgId={targetPkg}>
        <label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}>Section
          <select value={targetPkg} aria-label="Section for the new item" onChange={(e) => { setAddTarget(e.target.value); setAddingItem(false); }} style={{ height: 24, border: "1px solid var(--line-strong)", borderRadius: 0, background: "var(--paper)", font: "inherit" }}>
            {sections.length === 0 && <option value="">No sections yet</option>}
            {sections.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        {newSection.open ? (
          <>
            <input autoFocus value={newSection.name} placeholder="Section name" aria-label="New section name" style={{ height: 24, padding: "0 6px", border: "1px solid var(--line-strong)", borderRadius: 0, font: "inherit" }}
              onChange={(e) => setNewSection({ ...newSection, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void addSection(); if (e.key === "Escape") setNewSection({ open: false, name: "" }); }} />
            <button className="btn primary" disabled={!newSection.name.trim()} onClick={() => void addSection()}>Add section</button>
            <button className="btn" onClick={() => setNewSection({ open: false, name: "" })}>Cancel</button>
          </>
        ) : <button className="btn" disabled={session!.role === "viewer"} onClick={() => setNewSection({ open: true, name: "" })} title="A new QS section: its own package, so it is checked out like the others">New section</button>}
        <button className="btn" disabled={!canAdd || addingItem} onClick={() => setAddingItem(true)} title={targetPkg && !canAdd ? "Check out this section first" : "A new takeoff item in the chosen section"}>Add item</button>
        <button className="btn" disabled={!editable || !selectedQs} onClick={deleteItem}>Delete item</button>
        <button className="btn" disabled={!editable || !selectedQs} onClick={() => selectedQs && ws.addRow(pkgId, selectedQs)}>Add row</button>
        <button className="btn" disabled={!libId || !ws.canEdit(libId) || showNew} onClick={() => setShowNew(true)} title={libId && !ws.canEdit(libId) ? "Check out the Rate Library first (the second bar)" : "A resource that is not in either library yet: it is saved to the library for next time"}>New resource</button>
        <button className="btn" disabled={!editable || !selectedRow} onClick={() => { const r = buildRows.find((x) => x.rowId === selectedRow); if (r) { ws.removeRow(r.packageId, r.recordId); setSelectedRow(null); } }}>Delete row</button>
      </PackageBar>
      {libId && <PackageBar ws={ws} pkgId={libId} bare quiet />}
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      {!ws.notice && orphan && <div className="notice warn">${money(model.orphanCost)} of build-up cost has no QS item. It is in the price; assign or remove those rows.</div>}
      <div className="workbench">
        <section className="pane">
          <h3>QS Takeoff <span className="sub">{items.length} items</span></h3>
          <div className="grid">
            <AgGridReact<QsData>
              theme={gridTheme} rowData={qsRows} columnDefs={qsCols} getRowId={(p) => p.data.key} pinnedBottomRowData={totalRow} getRowClass={rowClass}
              pinnedTopRowData={addingItem ? [blankQs(targetSection)] : []}
              onCellEditingStopped={(e) => { if (e.rowPinned === "top" && !accepted.current) setAddingItem(false); }}
              onGridReady={(e) => { qsApi.current = e.api; }} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
              rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => n.data?.kind === "item" && !n.data.isNew }}
              onFirstDataRendered={(e) => e.api.forEachNode((n) => n.setSelected(n.data?.kind === "item" && n.data.code === selectedQs))}
              onSelectionChanged={(e) => { const r = e.api.getSelectedRows()[0]; if (r?.kind === "item") { setSelectedQs(r.code); setSelectedRow(null); setAddTarget(null); } }}
            />
          </div>
        </section>
        <section className="pane">
          <h3>Resource build-up <span className="sub">{selectedQs} · {items.find((i) => i.code === selectedQs)?.description} · {buildRows.length} rows</span></h3>
          <div className="grid">
            {buildRows.length === 0 ? (
              <div className="empty">No build-up rows for this item.{editable ? " Use Add row, then pick a resource from the library." : ""}</div>
            ) : (
              <AgGridReact<RowData>
                key={selectedQs} theme={gridTheme} rowData={buildRows} columnDefs={buildCols} getRowId={(p) => p.data.recordId} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
                rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
                onSelectionChanged={(e) => setSelectedRow(e.api.getSelectedRows()[0]?.rowId ?? null)}
              />
            )}
          </div>
          {showNew && libId && (
            <NewResource ws={ws} libraryId={libId} target={selectedBuildRow ? { packageId: selectedBuildRow.packageId, recordId: selectedBuildRow.recordId } : null}
              codes={model.library.map((l) => l.code)} onSavedToCompany={() => void reloadRates()} onClose={() => setShowNew(false)} />
          )}
        </section>
      </div>
    </>
  );
}
