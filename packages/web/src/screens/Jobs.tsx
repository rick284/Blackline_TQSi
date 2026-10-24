import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, apiUpload } from "../api.js";
import { dueDate, dueText, isOpen, STAGE_LABEL } from "../lib/enquiries.js";
import { money } from "../lib/fmt.js";
import { copyName, nameFromFile, REGISTER_VIEWS, type RegisterJob, type RegisterView, summarise, visible } from "../lib/register.js";
import { gridTheme, monoCell } from "../grid.js";
import { hrefJob } from "../route.js";
import { useSession } from "../session.js";
import { CompanyNav } from "./CompanyNav.js";
import { Shell } from "./Shell.js";

type Ask = { kind: "delete" | "copy"; job: RegisterJob; name: string };
const say = (e: unknown, f: string) => (e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : f);

/**
 * The Tender Register, the company's front page: every tender with its stage, owner, deadline and value, the totals across the top, and the
 * housekeeping a register needs. Archive takes a job out of the way; copy starts a new one from its work; delete removes a tender that was never
 * issued. An issued or awarded tender is frozen exactly as sent, so it can be archived but never deleted.
 */
export function Jobs() {
  const { session } = useSession();
  const role = session!.role;
  const canCreate = role !== "viewer";
  const isManager = role === "manager" || role === "owner";
  const [jobs, setJobs] = useState<RegisterJob[] | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [form, setForm] = useState({ name: "", client: "" });
  const [view, setView] = useState<RegisterView>("open");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useMemo(() => new Date(), []);

  const load = useCallback(async () => {
    try {
      const r = await api<RegisterJob[]>("GET", "/jobs?archived=1");
      if (!Array.isArray(r)) throw new Error("bad list");
      setJobs(r);
    } catch (e) { setNotice({ kind: "warn", text: say(e, "Could not load the jobs.") }); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => visible(jobs ?? [], view, q), [jobs, view, q]);
  const summary = useMemo(() => summarise(jobs ?? [], (j) => { const d = dueDate(j.due_at); return !!d && new Date(`${d}T00:00:00`).getTime() - now.getTime() < 7 * 86_400_000; }), [jobs, now]);
  const sel = (jobs ?? []).find((j) => j.id === selected) ?? null;
  const shown = sel && rows.some((r) => r.id === sel.id) ? sel : null;

  async function run(go: () => Promise<void>, fail: string) {
    setBusy(true);
    try { await go(); } catch (e) { setNotice({ kind: "warn", text: say(e, fail) }); }
    await load();
    setBusy(false);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const job = await api<RegisterJob>("POST", "/jobs", { name: form.name, client: form.client });
      window.location.hash = hrefJob(job.id).slice(1);
    }, "Could not create the job.");
  }

  /** A new tender from a Master Estimate Workbook: named from the boxes above, or the file name when the name box is empty. */
  async function importFile(file: File | undefined) {
    if (!file) return;
    const name = form.name.trim() || nameFromFile(file.name);
    setNotice({ kind: "info", text: `Reading ${file.name}…` });
    await run(async () => {
      const qs = new URLSearchParams({ name, ...(form.client.trim() ? { client: form.client.trim() } : {}) });
      const r = await apiUpload<{ job: RegisterJob }>(`/jobs/import-workbook?${qs}`, file);
      window.location.hash = hrefJob(r.job.id).slice(1);
    }, "That file could not be imported.");
  }

  function startCopy() {
    if (shown) setAsk({ kind: "copy", job: shown, name: copyName(shown.name, (jobs ?? []).map((j) => j.name)) });
  }

  async function confirm() {
    if (!ask) return;
    const a = ask;
    setAsk(null);
    if (a.kind === "delete") {
      await run(async () => {
        await api("POST", `/jobs/${a.job.id}/delete`);
        setSelected(null);
        setNotice({ kind: "info", text: `${a.job.name} deleted.` });
      }, "That job could not be deleted.");
    } else {
      await run(async () => {
        const job = await api<RegisterJob>("POST", `/jobs/${a.job.id}/copy`, { name: a.name.trim(), ...(a.job.client ? { client: a.job.client } : {}) });
        window.location.hash = hrefJob(job.id).slice(1);
      }, "That job could not be copied.");
    }
  }

  async function archive(j: RegisterJob, on: boolean) {
    await run(async () => {
      await api("POST", `/jobs/${j.id}/${on ? "archive" : "restore"}`);
      setNotice({ kind: "info", text: `${j.name} ${on ? "archived. Find it under Archived." : "restored to the register."}` });
    }, on ? "Could not archive that job." : "Could not restore that job.");
  }

  const cols: ColDef<RegisterJob>[] = [
    { field: "name", headerName: "Job", flex: 2, minWidth: 220, cellRenderer: (p: { data?: RegisterJob }) => (p.data ? <a href={hrefJob(p.data.id)}>{p.data.name}</a> : null) },
    { field: "client", headerName: "Client", flex: 1, minWidth: 130 },
    { field: "status", headerName: "Stage", width: 112, valueFormatter: (p) => STAGE_LABEL[p.value as string] ?? String(p.value) },
    { field: "owner_name", headerName: "Owner", width: 130, valueFormatter: (p) => p.value ?? "" },
    { field: "due_at", headerName: "Due", width: 108, valueFormatter: (p) => dueDate(p.value as string | null) },
    { colId: "when", headerName: "", width: 120, cellClass: "muted", valueGetter: (p) => (p.data && isOpen(p.data.status) ? dueText(p.data.due_at, now) : "") },
    { field: "approx_value", headerName: "Value", width: 118, cellStyle: monoCell, valueFormatter: (p) => (p.value ? money(p.value, 0) : "") },
    { field: "created_at", headerName: "Created", width: 112, valueFormatter: (p) => new Date(String(p.value)).toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" }) },
    { field: "notes", headerName: "Notes", flex: 1, minWidth: 120 },
  ];

  const tile = (label: string, value: string | number, v?: RegisterView) => (
    <button key={label} className={`tile${v && view === v ? " on" : ""}`} disabled={!v} onClick={() => v && setView(v)}>
      <span className="n">{value}</span><span className="l">{label}</span>
    </button>
  );

  return (
    <Shell crumbs={[{ label: "Tender Register" }]} nav={<CompanyNav current="register" />} plain>
      {canCreate && (
        <form className="jobform" onSubmit={create}>
          <input placeholder="New tender: job name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input placeholder="Client" value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} />
          <button className="btn primary" disabled={busy}>Create tender</button>
          {isManager && (
            <label className="btn" title="Create a tender from a Master Estimate Workbook (.xlsx). Uses the job name and client above, or the file name.">
              {busy ? "Working…" : "Import workbook…"}
              <input type="file" accept=".xlsx" aria-label="Import workbook" hidden disabled={busy} onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          )}
        </form>
      )}
      <div className="stats">
        {tile("Open", summary.open, "open")}
        {tile("Due within 7 days", summary.dueSoon)}
        {tile("Open pipeline", summary.pipeline === "0" ? "–" : money(summary.pipeline, 0))}
        {tile("Issued", summary.issued, "issued")}
        {tile("Awarded", summary.awarded, "awarded")}
        {tile("Lost and no bid", summary.closed, "closed")}
        {tile("Archived", summary.archived, "archived")}
      </div>
      <div className="toolbar" role="toolbar" aria-label="Register">
        <div className="group">
          <select value={view} aria-label="Show" onChange={(e) => setView(e.target.value as RegisterView)} style={{ height: 24, border: "1px solid var(--line-strong)", borderRadius: 0, background: "var(--paper)", font: "inherit" }}>
            {REGISTER_VIEWS.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}
          </select>
          <input className="find" placeholder="Find a tender, client or owner" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a tender" />
        </div>
        <div className="group">
          <a className="btn" style={{ textDecoration: "none", pointerEvents: shown ? "auto" : "none", opacity: shown ? 1 : 0.5 }} href={shown ? hrefJob(shown.id) : undefined}>Open</a>
          <button className="btn" disabled={!shown || !isManager || busy} title={isManager ? "Start a new tender from this one's work" : "A manager can copy a tender"} onClick={startCopy}>Copy</button>
          {shown?.archived_at
            ? <button className="btn" disabled={busy} onClick={() => void archive(shown, false)}>Restore</button>
            : <button className="btn" disabled={!shown || !canCreate || busy} title="Take it out of the register without deleting anything" onClick={() => shown && void archive(shown, true)}>Archive</button>}
          <button className="btn" disabled={!shown || !isManager || busy} title={!isManager ? "A manager can delete a tender" : shown && (shown.status === "issued" || shown.status === "awarded") ? "Issued and awarded tenders are kept as sent: archive instead" : ""}
            onClick={() => shown && setAsk({ kind: "delete", job: shown, name: "" })}>Delete</button>
        </div>
        <span className="muted">{rows.length} of {(jobs ?? []).length} job{(jobs ?? []).length === 1 ? "" : "s"}</span>
      </div>
      {ask && (
        <div className="notice warn ask" role="alertdialog">
          {ask.kind === "delete"
            ? <span>Delete {ask.job.name} and everything in it? This can't be undone. An issued or awarded tender can't be deleted.</span>
            : (
              <>
                <span>Copy {ask.job.name} as</span>
                <input aria-label="Name of the copy" value={ask.name} autoFocus onChange={(e) => setAsk({ ...ask, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && ask.name.trim()) void confirm(); }} style={{ minWidth: 280 }} />
              </>
            )}
          <button className="btn primary" style={{ marginLeft: "auto" }} disabled={ask.kind === "copy" && !ask.name.trim()} onClick={() => void confirm()}>{ask.kind === "delete" ? "Delete" : "Copy"}</button>
          <button className="btn" style={{ marginLeft: 0 }} onClick={() => setAsk(null)}>Cancel</button>
        </div>
      )}
      {notice && <div className={`notice ${notice.kind}`} role="alert">{notice.text}<button onClick={() => setNotice(null)}>Dismiss</button></div>}
      <div className="fill">
        {jobs && rows.length === 0 ? (
          <div className="empty">
            {(jobs ?? []).length === 0 ? <>No tenders yet.{canCreate ? " Create one above, or import a workbook." : ""}</> : q.trim() ? "Nothing matches that search." : "Nothing in this view."}
          </div>
        ) : (
          <AgGridReact<RegisterJob>
            theme={gridTheme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.id} loading={jobs === null} animateRows={false} suppressMovableColumns
            rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
            getRowClass={(p) => (p.data?.archived_at ? "row-archived" : "")}
            onRowDoubleClicked={(e) => { if (e.data) window.location.hash = hrefJob(e.data.id).slice(1); }}
            onSelectionChanged={(e) => setSelected(e.api.getSelectedRows()[0]?.id ?? null)}
          />
        )}
      </div>
    </Shell>
  );
}
