import { AgGridReact } from "ag-grid-react";
import type { ColDef, ColGroupDef, GridApi, RowClassParams } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection } from "../api.js";
import { gridTheme, monoCell } from "../grid.js";
import { parseNumberCell } from "../lib/draft.js";
import { money, num } from "../lib/fmt.js";
import { isBlocking, total, type BuildupRow, type QsRow } from "../lib/model.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";

const MODES = ["Time x Count", "QS Qty x Factor", "Direct Qty", "Lump Sum / Quote"];
const RESOURCE_TYPES = ["Labour", "Plant", "Material", "Subcontract", "Other"];

interface QsData extends QsRow { holder: string }
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
  const conn = useConnection();
  const model = ws.model!;
  const items = model.qsRows.filter((r) => r.kind === "item");
  const [selectedQs, setSelectedQs] = useState<string | null>(null);
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const qsApi = useRef<GridApi<QsData> | null>(null);

  useEffect(() => { if (!selectedQs || !items.some((i) => i.code === selectedQs)) setSelectedQs(items[0]?.code ?? null); }, [items, selectedQs]);
  // keep the grid's own selection on the chosen item, including after the rows are rebuilt by an edit
  useEffect(() => {
    qsApi.current?.forEachNode((n) => n.setSelected(n.data?.kind === "item" && n.data.code === selectedQs));
  }, [selectedQs, model]);

  const pkgId = selectedQs ? model.packageOfQs.get(selectedQs) ?? "" : "";
  const pkg = ws.pkg(pkgId);
  const mine = ws.isMine(pkgId);
  const editable = ws.canEdit(pkgId);
  const holder = pkg?.lock ? (mine ? "you" : pkg.lock.holder_name) : null;
  const canWrite = session!.role !== "viewer";
  const isManager = session!.role === "manager" || session!.role === "owner";
  const online = conn === "online";
  const changes = ws.changes(pkgId);

  const qsRows: QsData[] = useMemo(
    () => model.qsRows.map((r) => {
      const p = ws.pkg(r.packageId);
      return { ...r, holder: p?.lock ? (ws.isMine(r.packageId) ? "You" : p.lock.holder_name) : "" };
    }),
    [model, ws.packages], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const buildRows = useMemo(() => (selectedQs ? (model.buildups.get(selectedQs) ?? []).map(rowData) : []), [model, selectedQs]);

  const qsCols: (ColDef<QsData> | ColGroupDef<QsData>)[] = [
    { headerName: "Item", children: [
      { field: "code", headerName: "Code", width: 84, cellClass: "mono" },
      { field: "description", headerName: "Description", flex: 1, minWidth: 220 },
      { field: "unit", headerName: "Unit", width: 62 },
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
      textCol("resourceCode", "Resource", { width: 104, cellClass: (p) => (editable ? "cell-input mono" : "mono") }),
      { field: "resource", headerName: "Description", flex: 1, minWidth: 150 },
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

  const orphan = model.orphanCost.gt(0);
  const totalRow: QsData[] = [{ kind: "section", key: "total", code: "", section: "", description: "Total direct cost", unit: "", quantity: "", amount: total(model.qsRows), rate: null, rows: 0, flags: 0, recordId: "", packageId: "", holder: "" }];
  const rowClass = (p: RowClassParams<QsData>) => (p.data?.key === "total" ? "row-total" : p.data?.kind === "section" ? "row-section" : "");

  if (items.length === 0) return <div className="empty">This job has no QS items yet.</div>;

  return (
    <>
      <div className="toolbar" role="toolbar" aria-label="Package">
        <div className="group">
          <span className="label">Package</span>
          <strong>{pkg?.name ?? "—"}</strong>
          {holder === null ? <span className="badge">Free</span> : mine ? <span className="badge solid">{ws.queued[pkgId] ? "Check-in queued" : "Checked out by you"}</span> : <span className="badge grey">Held by {holder}</span>}
          <span className="muted">v{pkg?.version ?? "—"}</span>
        </div>
        <div className="group">
          <button className="btn primary" disabled={!canWrite || !pkg || !!pkg.lock || !online || ws.busy} onClick={() => ws.checkOut(pkgId)} title={online ? "" : "Checking out needs a connection"}>Check out</button>
          <button className="btn primary" disabled={!mine || ws.busy || !!ws.queued[pkgId]} onClick={() => ws.checkIn(pkgId)} title={online ? "" : "Offline: this will be queued and sent when you reconnect"}>Check in{changes ? ` (${changes})` : ""}{online ? "" : " when online"}</button>
          {ws.queued[pkgId] && <button className="btn" onClick={() => ws.cancelQueued(pkgId)}>Cancel queued check-in</button>}
          <button className="btn" disabled={!mine || !online || ws.busy} onClick={() => ws.release(pkgId)}>Release</button>
          {isManager && pkg?.lock && !mine && <button className="btn" disabled={!online || ws.busy} onClick={() => ws.breakLock(pkgId)}>Break lock</button>}
        </div>
        <div className="group">
          <button className="btn" disabled={!editable || !selectedQs} onClick={() => selectedQs && ws.addRow(pkgId, selectedQs)}>Add row</button>
          <button className="btn" disabled={!editable || !selectedRow} onClick={() => { const r = buildRows.find((x) => x.rowId === selectedRow); if (r) { ws.removeRow(r.packageId, r.recordId); setSelectedRow(null); } }}>Delete row</button>
        </div>
        {editable && <span className="muted">White cells are yours to change. Shaded cells are calculated.</span>}
        {!editable && pkg && <span className="muted">{holder === null ? "Check this package out to change it." : mine ? "" : `Read-only: ${holder} has this package.`}</span>}
      </div>
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      {!ws.notice && orphan && <div className="notice warn">${money(model.orphanCost)} of build-up cost has no QS item. It is in the price; assign or remove those rows.</div>}
      <div className="workbench">
        <section className="pane">
          <h3>QS Takeoff <span className="sub">{items.length} items</span></h3>
          <div className="grid">
            <AgGridReact<QsData>
              theme={gridTheme} rowData={qsRows} columnDefs={qsCols} getRowId={(p) => p.data.key} pinnedBottomRowData={totalRow} getRowClass={rowClass}
              onGridReady={(e) => { qsApi.current = e.api; }} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
              rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => n.data?.kind === "item" }}
              onFirstDataRendered={(e) => e.api.forEachNode((n) => n.setSelected(n.data?.kind === "item" && n.data.code === selectedQs))}
              onSelectionChanged={(e) => { const r = e.api.getSelectedRows()[0]; if (r?.kind === "item") { setSelectedQs(r.code); setSelectedRow(null); } }}
            />
          </div>
        </section>
        <section className="pane">
          <h3>Resource build-up <span className="sub">{selectedQs} · {items.find((i) => i.code === selectedQs)?.description} · {buildRows.length} rows</span></h3>
          <div className="grid">
            {buildRows.length === 0 ? (
              <div className="empty">No build-up rows for this item.{editable ? " Use Add row." : ""}</div>
            ) : (
              <AgGridReact<RowData>
                key={selectedQs} theme={gridTheme} rowData={buildRows} columnDefs={buildCols} getRowId={(p) => p.data.recordId} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
                rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
                onSelectionChanged={(e) => setSelectedRow(e.api.getSelectedRows()[0]?.rowId ?? null)}
              />
            )}
          </div>
        </section>
      </div>
    </>
  );
}
