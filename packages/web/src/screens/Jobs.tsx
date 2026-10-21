import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { gridTheme } from "../grid.js";
import { hrefJob } from "../route.js";
import { useSession } from "../session.js";
import { Shell } from "./Shell.js";

interface Job { id: string; name: string; client: string; status: string; created_at: string }

const STATUS_LABEL: Record<string, string> = { enquiry: "Enquiry", tender: "Tendering", issued: "Issued", awarded: "Awarded", lost: "Lost", "no-bid": "No bid" };

/** The Tender Register: every job the company has, one click into the estimate. */
export function Jobs() {
  const { session } = useSession();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", client: "" });
  const canCreate = session!.role !== "viewer";

  const load = useCallback(async () => {
    try { setJobs(await api<Job[]>("GET", "/jobs")); setError(null); } catch (e) { setError(e instanceof ApiError ? e.message : "Could not load the jobs."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      const job = await api<Job>("POST", "/jobs", { name: form.name, client: form.client });
      window.location.hash = hrefJob(job.id).slice(1);
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not create the job."); }
  }

  const cols: ColDef<Job>[] = [
    { field: "name", headerName: "Job", flex: 2, minWidth: 220, cellRenderer: (p: { data?: Job }) => (p.data ? <a href={hrefJob(p.data.id)}>{p.data.name}</a> : null) },
    { field: "client", headerName: "Client", flex: 1, minWidth: 140 },
    { field: "status", headerName: "Status", width: 120, valueFormatter: (p) => STATUS_LABEL[p.value as string] ?? String(p.value) },
    { field: "created_at", headerName: "Created", width: 130, valueFormatter: (p) => new Date(String(p.value)).toLocaleDateString("en-NZ", { day: "2-digit", month: "short", year: "numeric" }) },
  ];

  return (
    <Shell crumbs={[{ label: "Tender Register" }]} plain>
      {canCreate && (
        <form className="jobform" onSubmit={create}>
          <input placeholder="New tender: job name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          <input placeholder="Client" value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} />
          <button className="btn primary">Create tender</button>
        </form>
      )}
      {error && <div className="notice error">{error}</div>}
      <div className="fill">
        {jobs && jobs.length === 0 ? (
          <div className="empty">No tenders yet.{canCreate ? " Create one above." : ""}</div>
        ) : (
          <AgGridReact theme={gridTheme} rowData={jobs ?? []} columnDefs={cols} getRowId={(p) => p.data.id} loading={jobs === null} animateRows={false} />
        )}
      </div>
    </Shell>
  );
}
