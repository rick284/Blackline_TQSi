import { useState } from "react";
import { api, ApiError, apiUpload } from "../api.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";

const say = (e: unknown, f: string) => (e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : f);

/**
 * A job with nothing in it yet: start it blank (the standard commercial lines, overhead and profit at the percentages typed here, no sections) or import a
 * Master Estimate Workbook. Either way the job is then built up section by section on the Estimate screen.
 */
export function StartTender({ ws }: { ws: Workspace }) {
  const { session } = useSession();
  const role = session!.role;
  const [oh, setOh] = useState("10");
  const [pr, setPr] = useState("15");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "info" | "warn"; text: string } | null>(null);

  const start = async () => {
    setBusy(true);
    try { await api("POST", `/jobs/${ws.jobId}/template`, { overheadPct: oh, profitPct: pr }); await ws.load(); } catch (e) { setMsg({ kind: "warn", text: say(e, "The tender could not be started.") }); }
    setBusy(false);
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setMsg({ kind: "info", text: `Reading ${file.name}…` });
    try {
      const r = await apiUpload<{ packages: number; records: number; notes?: string[] }>(`/jobs/${ws.jobId}/import-workbook`, file);
      await ws.load();
      ws.notify({ kind: "info", text: `Imported ${r.records} records in ${r.packages} packages.${r.notes?.length ? ` ${r.notes.join(" ")}` : ""}` });
    } catch (e) { setMsg({ kind: "warn", text: say(e, "That file could not be imported.") }); }
    setBusy(false);
  };

  return (
    <div className="page sub-start">
      {msg && <div className={`notice ${msg.kind}`} role="alert">{msg.text}<button onClick={() => setMsg(null)}>Dismiss</button></div>}
      <h4>Start this tender</h4>
      <p className="muted">There is nothing in this job yet. Start it blank and build it up section by section, or bring in an existing Master Estimate Workbook.</p>
      <div className="sub-form" style={{ maxWidth: 520, margin: "8px 0" }}>
        <label><span>Overhead (% markup on cost)</span><input value={oh} aria-label="Overhead percentage" onChange={(e) => setOh(e.target.value)} disabled={role === "viewer"} /></label>
        <label><span>Profit (% margin on the price)</span><input value={pr} aria-label="Profit percentage" onChange={(e) => setPr(e.target.value)} disabled={role === "viewer"} /></label>
      </div>
      <p className="muted">These are starting points only. Every allowance, and these two, can be changed in Commercial Review.</p>
      <button className="btn primary" disabled={busy || role === "viewer"} onClick={() => void start()}>Start a blank tender</button>
      <h4 style={{ marginTop: 28 }}>Or import a workbook</h4>
      <p className="muted">A Master Estimate Workbook (.xlsx). Importing needs the manager role, and only works while the job is empty.</p>
      <input type="file" accept=".xlsx" aria-label="Workbook file" disabled={busy || !(role === "manager" || role === "owner")} onChange={(e) => void importFile(e.target.files?.[0])} />
      {!(role === "manager" || role === "owner") && <p className="muted">Ask a manager to import it.</p>}
    </div>
  );
}
