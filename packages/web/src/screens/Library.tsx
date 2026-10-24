import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridApi } from "ag-grid-community";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api.js";
import { gridTheme, monoCell } from "../grid.js";
import { num } from "../lib/fmt.js";
import { cleanRate, type CompanyRate, RATE_CODE, toCompanyInput } from "../lib/rateLibrary.js";
import { useCompanyRates } from "../lib/useCompanyRates.js";
import { useSession } from "../session.js";
import { CompanyNav } from "./CompanyNav.js";
import { Shell } from "./Shell.js";

const YES_NO = ["", "Yes", "No"];
const NEW = "__new";
type Row = CompanyRate & { isNew?: boolean };
const blank = (): Row => ({ id: NEW, code: "", category: "", description: "", unit: "", baseRate: "", operatorIncluded: "", fuelIncluded: "", source: "", updatedAt: "", isNew: true });
const say = (e: unknown, f: string) => (e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : f);

interface JobRef { id: string; name: string }

/**
 * The company Resource Library: the rates every estimate can pick from. Changes save as they are made. A tender takes its own copy of a rate when
 * it uses it, so changing a rate here never reprices a tender that has already been worked on; it applies to the next one that picks it.
 */
export function Library() {
  const { session } = useSession();
  const role = session!.role;
  const canEdit = role !== "viewer";
  const isManager = role === "manager" || role === "owner";
  const { rates, loaded, reload } = useCompanyRates();
  const [local, setLocal] = useState<CompanyRate[]>([]);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [jobs, setJobs] = useState<JobRef[]>([]);
  const [fromJob, setFromJob] = useState("");
  const [ask, setAsk] = useState<CompanyRate | null>(null);
  const [busy, setBusy] = useState(false);
  const gridApi = useRef<GridApi<Row> | null>(null);
  const accepted = useRef(false);
  const justAdded = useRef<string | null>(null);

  useEffect(() => setLocal(rates), [rates]);
  useEffect(() => { api<JobRef[]>("GET", "/jobs").then(setJobs).catch(() => undefined); }, []);

  const categories = useMemo(() => [...new Set(local.map((r) => r.category).filter(Boolean))].sort(), [local]);
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return local.filter((r) => (!category || r.category === category) && (!f || [r.code, r.category, r.description, r.source].some((x) => x.toLowerCase().includes(f))));
  }, [local, filter, category]);
  const sel = local.find((r) => r.id === selected) ?? null;

  useEffect(() => {
    if (!adding) return;
    accepted.current = false;
    const t = setTimeout(() => gridApi.current?.startEditingCell({ rowIndex: 0, rowPinned: "top", colKey: "code" }), 30);
    return () => clearTimeout(t);
  }, [adding]);

  // once the new rate has joined the list, carry on into its description
  useEffect(() => {
    const code = justAdded.current;
    const api_ = gridApi.current;
    if (!code || !api_) return;
    const r = local.find((x) => x.code === code);
    const node = r && api_.getRowNode(r.id);
    if (!r || !node) return;
    justAdded.current = null;
    setSelected(r.id);
    api_.ensureNodeVisible(node, "middle");
    setTimeout(() => {
      const n = api_.getRowNode(r.id);
      if (n?.rowIndex != null) { api_.setFocusedCell(n.rowIndex, "description"); api_.startEditingCell({ rowIndex: n.rowIndex, colKey: "description" }); }
    }, 350);
  }, [local]);

  /** Save one change. The grid shows it at once; if the server refuses, the list is read again so nothing misleading is left on screen. */
  const patch = useCallback(async (r: CompanyRate, change: Partial<CompanyRate>) => {
    setLocal((all) => all.map((x) => (x.id === r.id ? { ...x, ...change } : x)));
    try { await api("POST", `/rates/${r.id}`, change); } catch (e) { setNotice({ kind: "warn", text: say(e, "That could not be saved.") }); await reload(); }
  }, [reload]);

  const isNew = (p: { node: { rowPinned?: string | null } }) => p.node.rowPinned === "top";
  const text = (field: keyof CompanyRate, headerName: string, o: Partial<ColDef<Row>> = {}): ColDef<Row> => ({
    field: field as any, headerName, editable: (p) => !isNew(p) && canEdit, cellClass: (p) => (isNew(p) ? "cell-new" : canEdit ? "cell-input" : "cell-locked"),
    valueSetter: (p) => { void patch(p.data, { [field]: String(p.newValue ?? "").trim() }); return false; }, ...o,
  });

  const cols: ColDef<Row>[] = [
    {
      field: "code", headerName: "Code", width: 150, editable: (p) => isNew(p) || canEdit, cellClass: (p) => (isNew(p) ? "cell-new mono" : canEdit ? "cell-input mono" : "mono"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" && !p.value ? "New code…" : String(p.value ?? "")),
      valueSetter: (p) => {
        const code = String(p.newValue ?? "").trim();
        if (isNew({ node: p.node! })) {
          if (!code) return false; // left empty: the new line is dropped when editing stops
          if (!RATE_CODE.test(code)) { setNotice({ kind: "warn", text: "A code is letters, numbers, dots and dashes, up to 30 characters, for example LAB-CARP." }); return false; }
          if (local.some((r) => r.code.toLowerCase() === code.toLowerCase())) { setNotice({ kind: "warn", text: `${code} is already in the library.` }); return false; }
          accepted.current = true;
          setAdding(false);
          api<CompanyRate>("POST", "/rates", { code }).then((r) => { justAdded.current = r.code; setLocal((all) => [...all, r].sort((a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: "base" }))); void reload(); })
            .catch((e) => setNotice({ kind: "warn", text: say(e, "The rate could not be added.") }));
          return false;
        }
        if (!RATE_CODE.test(code)) { setNotice({ kind: "warn", text: "A code is letters, numbers, dots and dashes, up to 30 characters." }); return false; }
        if (local.some((r) => r.id !== p.data.id && r.code.toLowerCase() === code.toLowerCase())) { setNotice({ kind: "warn", text: `${code} is already in the library.` }); return false; }
        setNotice({ kind: "info", text: "Renaming a code here doesn't change tenders that already took a copy of it." });
        void patch(p.data, { code });
        return false;
      },
    },
    text("category", "Category", { width: 120 }),
    text("description", "Description", { flex: 1, minWidth: 260 }),
    text("unit", "Unit", { width: 70 }),
    {
      field: "baseRate", headerName: "Rate", width: 112, cellStyle: monoCell, editable: (p) => !isNew(p) && canEdit, cellClass: (p) => (isNew(p) ? "cell-new" : canEdit ? "cell-input" : "cell-locked"),
      valueFormatter: (p) => (p.node?.rowPinned === "top" ? "" : num(p.value, 4)),
      valueSetter: (p) => {
        const r = cleanRate(p.newValue);
        if (r === null) { setNotice({ kind: "warn", text: "A rate needs a number, for example 85.50." }); return false; }
        void patch(p.data, { baseRate: r });
        return false;
      },
    },
    text("operatorIncluded", "Operator in rate", { width: 130, cellEditor: "agSelectCellEditor", cellEditorParams: { values: YES_NO } }),
    text("fuelIncluded", "Fuel in rate", { width: 112, cellEditor: "agSelectCellEditor", cellEditorParams: { values: YES_NO } }),
    text("source", "Source", { flex: 1, minWidth: 180 }),
    { field: "updatedAt", headerName: "Changed", width: 112, cellClass: "cell-calc", valueFormatter: (p) => (p.value ? new Date(String(p.value)).toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" }) : "") },
  ];

  async function addFromJob() {
    if (!fromJob) return;
    setBusy(true);
    try {
      const pkgs = await api<{ id: string; kind: string }[]>("GET", `/jobs/${fromJob}/packages`);
      const lib = pkgs.find((p) => p.kind === "library");
      if (!lib) { setNotice({ kind: "warn", text: "That job has no Rate Library." }); setBusy(false); return; }
      const detail = await api<{ records: Record<string, { kind: string; body: any }> }>("GET", `/packages/${lib.id}`);
      const mine = Object.values(detail.records).filter((r) => r.kind === "library").map((r) => toCompanyInput(r.body)).filter((r): r is NonNullable<typeof r> => !!r);
      if (mine.length === 0) { setNotice({ kind: "info", text: "That job's Rate Library has no rates to add." }); setBusy(false); return; }
      const r = await api<{ added: number; skipped: number }>("POST", "/rates/bulk", { rates: mine });
      setNotice({ kind: "info", text: `${r.added} rate${r.added === 1 ? "" : "s"} added to the company library${r.skipped ? `; ${r.skipped} already there, left as they are` : ""}.` });
      await reload();
    } catch (e) { setNotice({ kind: "warn", text: say(e, "That job's rates could not be added.") }); }
    setBusy(false);
  }

  async function remove() {
    const r = ask;
    setAsk(null);
    if (!r) return;
    try {
      await api("POST", `/rates/${r.id}/delete`);
      setSelected(null);
      setNotice({ kind: "info", text: `${r.code} removed from the company library. Tenders that already use it keep their own copy.` });
    } catch (e) { setNotice({ kind: "warn", text: say(e, "That rate could not be removed.") }); }
    await reload();
  }

  return (
    <Shell crumbs={[{ label: "Tender Register", href: "#/" }, { label: "Resource Library" }]} nav={<CompanyNav current="library" />} plain>
      <div className="toolbar" role="toolbar" aria-label="Resource library">
        <div className="group">
          <button className="btn primary" disabled={!canEdit || adding} onClick={() => setAdding(true)}>Add rate</button>
          <button className="btn" disabled={!isManager || !sel} title={isManager ? "Tenders that already use it keep their own copy" : "A manager can remove a rate"} onClick={() => sel && setAsk(sel)}>Delete rate</button>
        </div>
        <div className="group">
          <select value={category} aria-label="Category" onChange={(e) => setCategory(e.target.value)} style={{ height: 24, border: "1px solid var(--line-strong)", borderRadius: 0, background: "var(--paper)", font: "inherit" }}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c}>{c}</option>)}
          </select>
          <input className="find" placeholder="Find a rate" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a rate" />
        </div>
        <div className="group">
          <select value={fromJob} aria-label="Take rates from a tender" disabled={!canEdit} onChange={(e) => setFromJob(e.target.value)} style={{ height: 24, border: "1px solid var(--line-strong)", borderRadius: 0, background: "var(--paper)", font: "inherit", maxWidth: 220 }}>
            <option value="">Add rates from a tender…</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.name}</option>)}
          </select>
          <button className="btn" disabled={!fromJob || busy} onClick={() => void addFromJob()} title="Adds every rate in that tender's Rate Library that the company library doesn't have yet">Add its rates</button>
        </div>
        <span className="muted">{rows.length === local.length ? `${local.length} rate${local.length === 1 ? "" : "s"}` : `${rows.length} of ${local.length} rates`}{adding ? " · type the new code and press Enter" : ""}</span>
      </div>
      {ask && (
        <div className="notice warn ask" role="alertdialog">
          <span>Remove {ask.code} from the company library? Tenders that already use it keep their own copy.</span>
          <button className="btn primary" style={{ marginLeft: "auto" }} onClick={() => void remove()}>Remove</button>
          <button className="btn" style={{ marginLeft: 0 }} onClick={() => setAsk(null)}>Cancel</button>
        </div>
      )}
      {notice && <div className={`notice ${notice.kind}`} role="alert">{notice.text}<button onClick={() => setNotice(null)}>Dismiss</button></div>}
      <div className="fill">
        {loaded && local.length === 0 && !adding ? (
          <div className="empty">The company library is empty.{canEdit ? " Add a rate, or take the rates from a tender you have already built. Rates you create while estimating are saved here too." : ""}</div>
        ) : (
          <AgGridReact<Row>
            theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.id} loading={!loaded} animateRows={false} suppressMovableColumns singleClickEdit stopEditingWhenCellsLoseFocus
            pinnedTopRowData={adding ? [blank()] : []}
            onGridReady={(e) => { gridApi.current = e.api; }}
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true, isRowSelectable: (n) => !n.data?.isNew }}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0]?.id ?? null)}
            onCellEditingStopped={(e) => { if (e.rowPinned === "top" && !accepted.current) setAdding(false); }}
          />
        )}
      </div>
    </Shell>
  );
}
