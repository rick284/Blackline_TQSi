import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { useEffect, useMemo, useRef, useState } from "react";
import { scope as sc } from "@blackline/tender/core";
import { gridTheme, monoCell } from "../grid.js";
import { addReference, newScopeItem, setScopeField, type ScopeBody } from "../lib/scope.js";
import type { Workspace } from "../workspace.js";
import { PackageBar } from "./PackageBar.js";
import { ReferencePanel } from "./References.js";

type Item = ReturnType<typeof computeItems>[number] & { isNew?: boolean };
const computeItems = (ws: Workspace) => ws.model!.estimate.scope.items;
const NEW = "__new";
const blank = (): Item => ({ id: NEW, ref: "", group: "", title: "", detail: "", source: "", owner: "", treatment: "", cost_refs: "", register_refs: "", quote_refs: "", basis: "", action: "", status: "MISSING", problems: [], isNew: true });

const list = (xs: readonly string[]) => ["", ...xs];

/**
 * The Scope Register. Every requirement of the job (permanent works, enabling works, access, temporary works, testing, interfaces with
 * others) says who delivers it and how the price treats it, and the register checks that the treatment is backed up: a priced item points
 * at the QS items that carry its cost, an exclusion is recorded in the register, subcontract work has a quote. The platform never picks a
 * treatment; it checks yours. The reference panel underneath lists the register and the quotes, so a link is one click.
 */
export function Scope({ ws }: { ws: Workspace }) {
  const model = ws.model!;
  const result = model.estimate.scope;
  const pkgId = ws.packages.find((p) => p.kind === "narrative")?.id ?? "";
  const editable = !!pkgId && ws.canEdit(pkgId);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const gridApi = useRef<GridApi<Item> | null>(null);
  const accepted = useRef(false);

  useEffect(() => {
    if (!adding) return;
    accepted.current = false;
    const t = setTimeout(() => gridApi.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: "title" }), 30);
    return () => clearTimeout(t);
  }, [adding]);

  // once the new item has joined the register, bring it into view and carry on into its group
  useEffect(() => {
    if (!justAdded) return;
    const api = gridApi.current;
    const node = api?.getRowNode(`scope:${justAdded}`);
    if (!api || !node) return;
    const id = justAdded;
    setJustAdded(null);
    setSelected(id);
    api.ensureNodeVisible(node, "middle");
    setTimeout(() => {
      const n = api.getRowNode(`scope:${id}`);
      if (n?.rowIndex != null) { api.setFocusedCell(n.rowIndex, "group"); api.startEditingCell({ rowIndex: n.rowIndex, colKey: "group" }); }
    }, 350);
  }, [justAdded, result.items]);

  const isNew = (p: { node: { rowPinned?: string | null } }) => p.node.rowPinned === "top";
  const recordOf = (id: string) => `scope:${id}`;

  /** Change one field through the shared rules; what is wrong is said in the page, and nothing changes. */
  const change = (row: Item, field: string, value: unknown) => {
    const problem = { text: "" };
    ws.edit(pkgId, recordOf(row.id), (b: ScopeBody) => {
      const r = setScopeField(b, field, value);
      if (!r.ok) { problem.text = r.error; return b; }
      return r.body;
    });
    if (problem.text) ws.notify({ kind: "warn", text: problem.text });
  };

  const text = (field: keyof ScopeBody, headerName: string, o: Partial<ColDef<Item>> = {}): ColDef<Item> => ({
    field: field as any, headerName,
    editable: (p) => !isNew(p) && editable,
    cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { change(p.data, field, p.newValue); return false; },
    ...o,
  });
  const choice = (field: keyof ScopeBody, headerName: string, values: readonly string[], width: number): ColDef<Item> =>
    text(field, headerName, { width, cellEditor: "agSelectCellEditor", cellEditorParams: { values: list(values) } });

  const cols: ColDef<Item>[] = [
    { field: "ref", headerName: "Ref", width: 84, cellClass: (p) => (isNew(p) ? "cell-new mono" : "cell-calc mono"), valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")) },
    {
      field: "status", headerName: "Status", width: 96, valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : String(p.value ?? "")),
      cellClass: (p) => (isNew(p) ? "cell-new" : `cell-calc status-${String(p.value).toLowerCase()}`),
    },
    {
      field: "title", headerName: "Requirement", flex: 1, minWidth: 260,
      editable: (p) => isNew(p) || editable,
      cellClass: (p) => (isNew(p) ? "cell-new" : editable ? "cell-input" : "cell-locked"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? "New requirement…" : String(p.value ?? "")),
      valueSetter: (p) => {
        if (!isNew({ node: p.node! })) { change(p.data, "title", p.newValue); return false; }
        const title = String(p.newValue ?? "").trim();
        if (!title) return false; // left empty: the new line is dropped when editing stops
        const ids = result.items.map((x) => x.id);
        const made = newScopeItem(title, result.items as ScopeBody[], ids, ws.nextSeq("scope"));
        if (!made.ok) { ws.notify({ kind: "warn", text: made.error }); return false; }
        accepted.current = true;
        ws.adopt(pkgId, made.recordId, made.data);
        setAdding(false);
        setJustAdded((made.data.body as ScopeBody).id);
        return false;
      },
    },
    choice("group", "Group", sc.GROUPS, 190),
    choice("owner", "Owner", sc.OWNERS, 120),
    choice("treatment", "Treatment", sc.TREATMENTS, 120),
    text("cost_refs", "QS items / lines", { width: 140, tooltipField: "cost_refs" }),
    text("register_refs", "Register refs", { width: 130, tooltipField: "register_refs" }),
    text("quote_refs", "Quotes", { width: 100 }),
    text("basis", "Basis", { flex: 1, minWidth: 200 }),
    { field: "problems", headerName: "To fix", width: 70, cellStyle: monoCell, cellClass: "cell-calc", valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : p.value?.length ? String(p.value.length) : "") },
  ];

  const sel = result.items.find((x) => x.id === selected) as Item | undefined;

  /** Add the picked reference (or QS code) to the selected item's list. */
  const link = (field: "cost_refs" | "register_refs" | "quote_refs", ref: string) => {
    if (!sel) return;
    const problem = { text: "" };
    ws.edit(pkgId, recordOf(sel.id), (b: ScopeBody) => { const r = addReference(b, field, ref); if (!r.ok) { problem.text = r.error; return b; } return r.body; });
    if (problem.text) ws.notify({ kind: "warn", text: problem.text });
  };

  const gateClass = result.gate.startsWith("PASS") ? "notice" : result.gate.startsWith("HOLD") ? "notice error" : "notice warn";

  if (!pkgId) return <div className="empty">This job has no register package yet.</div>;

  return (
    <>
      <PackageBar ws={ws} pkgId={pkgId}>
        <button className="btn" disabled={!editable || adding} onClick={() => setAdding(true)}>Add requirement</button>
        <button className="btn" disabled={!editable || !sel} onClick={() => { if (sel) { ws.removeRow(pkgId, recordOf(sel.id)); setSelected(null); } }}>Delete requirement</button>
      </PackageBar>
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className={`${gateClass} wrap`} role="status">
        <strong>Scope gate</strong> <span style={{ flex: 1 }}>{result.gate}</span>
        <span style={{ whiteSpace: "nowrap" }}>
          {result.counts.total === 0 ? "" : `${result.counts.COMPLETE} complete · ${result.counts.CHECK} to check · ${result.counts.MISSING} missing`}
        </span>
      </div>
      {result.unhomedQs.length > 0 && (
        <div className="notice warn wrap">
          <span style={{ whiteSpace: "nowrap" }}>Priced QS items no requirement points at:</span>
          <span className="chips">
            {result.unhomedQs.map((c) => (
              <button key={c} className="chip" disabled={!editable || !sel} title={sel ? `Add ${c} to ${sel.ref}` : "Select a requirement to link it"} onClick={() => link("cost_refs", c)}>{c}</button>
            ))}
          </span>
        </div>
      )}

      <div className="pane" style={{ flex: "3 1 0" }}>
        <h3>Requirements <span className="sub">{result.counts.total} {result.counts.total === 1 ? "item" : "items"}{adding ? " · type the requirement and press Enter" : ""}</span></h3>
        <div className="grid">
          <AgGridReact<Item>
            theme={gridTheme} rowData={result.items as Item[]} columnDefs={cols} getRowId={(p) => recordOf(p.data.id)} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
            pinnedTopRowData={adding ? [blank()] : []}
            onGridReady={(e) => { gridApi.current = e.api; }}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0]?.id ?? null)}
            onCellEditingStopped={(e) => { if (e.rowPinned === "top" && !accepted.current) setAdding(false); }}
            noRowsOverlayComponent={() => <span className="muted">No requirements yet. Add the first one: say what the job needs, then who delivers it and how it is priced.</span>}
          />
        </div>
        {sel && sel.problems.length > 0 && (
          <div className="problems" role="status">
            <strong>{sel.ref}</strong> {sel.problems.map((p) => <span key={p}>{p}</span>)}
          </div>
        )}
        {sel && sel.problems.length === 0 && <div className="problems"><strong>{sel.ref}</strong> <span>Owned, treated and backed up.</span></div>}
      </div>

      <ReferencePanel ws={ws} model={model} pkgId={pkgId} editable={editable} target={sel ? { ref: sel.ref } : null} onLink={link} />
    </>
  );
}
