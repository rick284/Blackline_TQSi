import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { gridTheme, monoCell } from "../grid.js";
import { money } from "../lib/fmt.js";
import { KINDS, RAGS, newQuote, newRegisterItem, setQuoteField, setRegisterField, type QuoteBody, type RegisterBody } from "../lib/registers.js";
import type { Model } from "../lib/model.js";
import type { Workspace } from "../workspace.js";

const NEW = "__new";
type RRow = RegisterBody & { isNew?: boolean };
type QRow = QuoteBody & { isNew?: boolean };
type Tab = "register" | "quotes";

const blankRegister = (kind: string): RRow => ({ id: NEW, kind: kind as RRow["kind"], ref: "", title: "", detail: "", action: "", status: "", rag: "", owner: "", likelihood: "", impact: "", rating: "", isNew: true });
const blankQuote = (): QRow => ({ id: NEW, ref: "", package: "", supplier: "", estimate_ref: "", qty: "", unit: "", amount: "", scope: "", documents: "", status: "", action: "", notes: "", treatment: "", verification: "", source: "", quote_date: "", valid_until: "", isNew: true });

interface Common { ws: Workspace; pkgId: string; editable: boolean; adding: boolean; onAdded: () => void; onCancel: () => void; onPick: (recordId: string | null, ref: string | null) => void }

/**
 * The register and the quote register, under the scope requirements. Both edit in place like the other grids: white cells are yours on a
 * checked-out package, "Add" opens a new line at the top (type the title and press Enter, then carry on across it), and a wrong value is
 * explained in the page and not applied. Pick a row and "Link" adds its reference to the selected requirement.
 */
export function ReferencePanel({ ws, model, pkgId, editable, target, onLink }: {
  ws: Workspace; model: Model; pkgId: string; editable: boolean;
  target: { ref: string } | null;
  onLink: (field: "register_refs" | "quote_refs", ref: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("register");
  const [kind, setKind] = useState("");
  const [picked, setPicked] = useState<{ recordId: string; ref: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const kinds = useMemo(() => [...new Set(model.register.map((x) => x.kind))], [model.register]);
  const switchTab = (t: Tab) => { setTab(t); setPicked(null); setAdding(false); };
  const common: Common = {
    ws, pkgId, editable, adding, onAdded: () => setAdding(false), onCancel: () => setAdding(false),
    onPick: (recordId, ref) => setPicked(recordId && ref ? { recordId, ref } : null),
  };

  return (
    <div className="pane" style={{ flex: "2 1 0" }}>
      <h3>
        Reference
        <span className="tabs">
          <button className={tab === "register" ? "on" : ""} onClick={() => switchTab("register")}>Register ({model.register.length})</button>
          <button className={tab === "quotes" ? "on" : ""} onClick={() => switchTab("quotes")}>Quotes ({model.quotes.length})</button>
        </span>
        {tab === "register" && kinds.length > 0 && (
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of register item" style={{ height: 20 }}>
            <option value="">All kinds</option>
            {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button className="btn" disabled={!editable || adding} onClick={() => setAdding(true)}>{tab === "register" ? "Add register item" : "Add quote"}</button>
          <button className="btn" disabled={!editable || !picked} onClick={() => { if (picked) { ws.removeRow(pkgId, picked.recordId); setPicked(null); } }}>{tab === "register" ? "Delete item" : "Delete quote"}</button>
          <button className="btn" disabled={!editable || !target || !picked} onClick={() => picked && onLink(tab === "register" ? "register_refs" : "quote_refs", picked.ref)}>
            {target && picked ? `Link ${picked.ref} to ${target.ref}` : "Link to the selected requirement"}
          </button>
        </span>
      </h3>
      <div className="grid">
        {tab === "register"
          ? <RegisterGrid {...common} rows={model.register.filter((x) => !kind || x.kind === kind)} all={model.register} defaultKind={kind || "assumption"} />
          : <QuoteGrid {...common} rows={model.quotes} />}
      </div>
    </div>
  );
}

/** A field change through the shared rules, with what is wrong said in the page. */
function useChange<B>(ws: Workspace, pkgId: string, prefix: string, set: (b: B, f: string, v: unknown) => { ok: true; body: B } | { ok: false; error: string }) {
  return (id: string, field: string, value: unknown) => {
    const problem = { text: "" };
    ws.edit(pkgId, `${prefix}:${id}`, (b: B) => { const r = set(b, field, value); if (!r.ok) { problem.text = r.error; return b; } return r.body; });
    if (problem.text) ws.notify({ kind: "warn", text: problem.text });
  };
}

/** The pinned new line shared by both grids: opens its first cell, drops itself if left empty, and moves on across the new row once it exists. */
function useNewLine<R>(adding: boolean, firstCol: string, nextCol: string, recordPrefix: string, onCancel: () => void) {
  const api = useRef<GridApi<R> | null>(null);
  const accepted = useRef(false);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  useEffect(() => {
    if (!adding) return;
    accepted.current = false;
    const t = setTimeout(() => api.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: firstCol }), 30);
    return () => clearTimeout(t);
  }, [adding, firstCol]);
  useEffect(() => {
    if (!justAdded) return;
    const a = api.current;
    const node = a?.getRowNode(`${recordPrefix}:${justAdded}`);
    if (!a || !node) return;
    const id = justAdded;
    setJustAdded(null);
    a.ensureNodeVisible(node, "middle");
    setTimeout(() => {
      const n = a.getRowNode(`${recordPrefix}:${id}`);
      if (n?.rowIndex != null) { a.setFocusedCell(n.rowIndex, nextCol); a.startEditingCell({ rowIndex: n.rowIndex, colKey: nextCol }); }
    }, 350);
  });
  return { api, accepted, setJustAdded, onStopped: (pinned: boolean) => { if (pinned && !accepted.current) onCancel(); } };
}

const isNew = (p: { node: { rowPinned?: string | null } }) => p.node.rowPinned === "top";

function RegisterGrid({ ws, pkgId, editable, adding, onAdded, onCancel, onPick, rows, all, defaultKind }: Common & { rows: RegisterBody[]; all: RegisterBody[]; defaultKind: string }) {
  const [newKind, setNewKind] = useState(defaultKind);
  useEffect(() => setNewKind(defaultKind), [defaultKind, adding]);
  const line = useNewLine<RRow>(adding, "title", "detail", "register", onCancel);
  const change = useChange<RegisterBody>(ws, pkgId, "register", setRegisterField);

  const field = (f: keyof RegisterBody, headerName: string, o: Partial<ColDef<RRow>> = {}): ColDef<RRow> => ({
    field: f as any, headerName,
    editable: (p) => !isNew(p) && editable,
    cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { change(p.data.id, f, p.newValue); return false; },
    ...o,
  });

  const cols: ColDef<RRow>[] = [
    {
      field: "kind", headerName: "Kind", width: 110, editable: (p) => isNew(p), cellEditor: "agSelectCellEditor", cellEditorParams: { values: [...KINDS] },
      cellClass: (p) => (isNew(p) ? "cell-new" : "cell-calc"),
      valueSetter: (p) => { if (isNew({ node: p.node! })) setNewKind(String(p.newValue)); return false; },
    },
    { field: "ref", headerName: "Ref", width: 90, cellClass: (p) => (isNew(p) ? "cell-new mono" : "cell-calc mono"), valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")) },
    {
      field: "title", headerName: "Title", flex: 1, minWidth: 260,
      editable: (p) => isNew(p) || editable,
      cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? `New ${newKind}…` : String(p.value ?? "")),
      valueSetter: (p) => {
        if (!isNew({ node: p.node! })) { change(p.data.id, "title", p.newValue); return false; }
        const title = String(p.newValue ?? "").trim();
        if (!title) return false;
        const made = newRegisterItem(newKind, title, all, all.map((x) => x.id), ws.nextSeq("register"));
        if (!made.ok) { ws.notify({ kind: "warn", text: made.error }); return false; }
        line.accepted.current = true;
        ws.adopt(pkgId, made.recordId, made.data);
        onAdded();
        line.setJustAdded((made.data.body as RegisterBody).id);
        return false;
      },
    },
    field("detail", "Detail", { flex: 1, minWidth: 220, tooltipField: "detail" }),
    field("status", "Status", { width: 96 }),
    field("rag", "Rating", { width: 90, cellEditor: "agSelectCellEditor", cellEditorParams: { values: RAGS } }),
    field("owner", "Owner", { width: 120 }),
    field("action", "Action", { flex: 1, minWidth: 180 }),
    field("likelihood", "Likelihood", { width: 96 }),
    field("impact", "Impact", { width: 84 }),
    field("rating", "Risk rating", { width: 96 }),
  ];

  return (
    <AgGridReact<RRow>
      theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => `register:${p.data.id}`} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
      pinnedTopRowData={adding ? [blankRegister(newKind)] : []}
      onGridReady={(e) => { line.api.current = e.api; }}
      rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
      onSelectionChanged={(e) => { const r = e.api.getSelectedRows()[0]; onPick(r ? `register:${r.id}` : null, r?.ref ?? null); }}
      onCellEditingStopped={(e) => line.onStopped(e.rowPinned === "top")}
    />
  );
}

function QuoteGrid({ ws, pkgId, editable, adding, onAdded, onCancel, onPick, rows }: Common & { rows: QuoteBody[] }) {
  const line = useNewLine<QRow>(adding, "package", "supplier", "quote", onCancel);
  const change = useChange<QuoteBody>(ws, pkgId, "quote", setQuoteField);

  const field = (f: keyof QuoteBody, headerName: string, o: Partial<ColDef<QRow>> = {}): ColDef<QRow> => ({
    field: f as any, headerName,
    editable: (p) => !isNew(p) && editable,
    cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { change(p.data.id, f, p.newValue); return false; },
    ...o,
  });

  const cols: ColDef<QRow>[] = [
    { field: "ref", headerName: "Quote", width: 80, cellClass: (p) => (isNew(p) ? "cell-new mono" : "cell-calc mono"), valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")) },
    {
      field: "package", headerName: "Package", flex: 1, minWidth: 220,
      editable: (p) => isNew(p) || editable,
      cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? "New quote: what it covers…" : String(p.value ?? "")),
      valueSetter: (p) => {
        if (!isNew({ node: p.node! })) { change(p.data.id, "package", p.newValue); return false; }
        const name = String(p.newValue ?? "").trim();
        if (!name) return false;
        const made = newQuote(name, rows, rows.map((x) => x.id), ws.nextSeq("quote"));
        if (!made.ok) { ws.notify({ kind: "warn", text: made.error }); return false; }
        line.accepted.current = true;
        ws.adopt(pkgId, made.recordId, made.data);
        onAdded();
        line.setJustAdded((made.data.body as QuoteBody).id);
        return false;
      },
    },
    field("supplier", "Supplier", { width: 200 }),
    field("estimate_ref", "Estimate ref", { width: 120 }),
    field("qty", "Qty", { width: 76, cellStyle: monoCell }),
    field("unit", "Unit", { width: 64 }),
    field("amount", "Amount", { width: 110, cellStyle: monoCell, valueFormatter: (p) => (p.node?.rowPinned === "top" || !p.value ? "" : money(p.value)) }),
    field("quote_date", "Quote date", { width: 100 }),
    field("valid_until", "Valid until", { width: 100 }),
    field("status", "Status", { flex: 1, minWidth: 200 }),
    field("action", "Action", { flex: 1, minWidth: 180 }),
    field("notes", "Notes", { flex: 1, minWidth: 200 }),
    field("scope", "Scope", { flex: 1, minWidth: 200 }),
    field("documents", "Documents", { flex: 1, minWidth: 160 }),
  ];

  return (
    <AgGridReact<QRow>
      theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => `quote:${p.data.id}`} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
      pinnedTopRowData={adding ? [blankQuote()] : []}
      onGridReady={(e) => { line.api.current = e.api; }}
      rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
      onSelectionChanged={(e) => { const r = e.api.getSelectedRows()[0]; onPick(r ? `quote:${r.id}` : null, r?.ref ?? null); }}
      onCellEditingStopped={(e) => line.onStopped(e.rowPinned === "top")}
    />
  );
}
