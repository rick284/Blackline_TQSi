import { useState } from "react";
import { api, ApiError } from "../api.js";
import { cleanRate, libraryBody, RATE_CODE, RESOURCE_TYPES } from "../lib/rateLibrary.js";
import type { Workspace } from "../workspace.js";

/**
 * A resource that is not in the library yet, made without leaving the estimate: it goes into this job's Rate Library, onto the build-up row that
 * is selected, and (unless unticked) into the company resource library so the next estimate can pick it. Opens in the page under the build-up,
 * never over it.
 */
export function NewResource({ ws, libraryId, target, codes, onSavedToCompany, onClose }: {
  ws: Workspace; libraryId: string; target: { packageId: string; recordId: string } | null; codes: string[]; onSavedToCompany: () => void; onClose: () => void;
}) {
  const [f, setF] = useState({ code: "", type: "Labour", description: "", unit: "", rate: "", company: true });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    const code = f.code.trim();
    if (!RATE_CODE.test(code)) return setErr("A code is letters, numbers, dots and dashes, up to 30 characters, for example LAB-CARP.");
    if (codes.some((c) => c.toLowerCase() === code.toLowerCase())) return setErr(`${code} is already in this job's library. Pick it from the list instead.`);
    const rate = cleanRate(f.rate);
    if (rate === null) return setErr("The rate needs to be a number, for example 85.50.");
    if (!f.description.trim()) return setErr("Describe the resource so it can be found again.");
    if (!ws.canEdit(libraryId)) return setErr("Check out the Rate Library first.");

    const body = libraryBody({ code, category: f.type, description: f.description.trim(), unit: f.unit.trim(), baseRate: rate, operatorIncluded: "", fuelIncluded: "", source: "Added while estimating" });
    const lib = { recordId: `library:${code}`, data: { kind: "library", seq: ws.nextSeq("library"), body } };
    const row = target && ws.canEdit(target.packageId) ? ws.record(target.recordId) : undefined;
    if (target && row) {
      ws.batchMulti([
        { packageId: libraryId, ...lib },
        { packageId: target.packageId, recordId: target.recordId, data: { ...row, body: { ...(row.body as object), resourceCode: code, resourceType: f.type } } },
      ]);
    } else ws.batch(libraryId, [lib]);

    let note = row ? `${code} added to this job's library and used on the selected row.` : `${code} added to this job's library.`;
    if (f.company) {
      setBusy(true);
      try {
        await api("POST", "/rates", body);
        onSavedToCompany();
        note += " Saved to the company library.";
      } catch (e) {
        note += e instanceof ApiError && e.code === "rate_exists" ? " The company library already has that code, so it was left as it is." : ` It could not be saved to the company library${e instanceof ApiError && e.status === 0 ? " (you are offline)" : ""}; do that from the Rate Library page.`;
      }
      setBusy(false);
    }
    ws.notify({ kind: "info", text: note });
    onClose();
  }

  return (
    <div className="newres" role="form" aria-label="New resource">
      <div className="row">
        <label>Code<input autoFocus value={f.code} onChange={(e) => set("code", e.target.value)} style={{ width: 120 }} placeholder="LAB-CARP" /></label>
        <label>Type<select value={f.type} onChange={(e) => set("type", e.target.value)}>{RESOURCE_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
        <label style={{ flex: 1, minWidth: 220 }}>Description<input value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Carpenter, qualified" /></label>
        <label>Unit<input value={f.unit} onChange={(e) => set("unit", e.target.value)} style={{ width: 64 }} placeholder="hr" /></label>
        <label>Rate<input value={f.rate} onChange={(e) => set("rate", e.target.value)} style={{ width: 96, textAlign: "right" }} placeholder="0.00" inputMode="decimal" onKeyDown={(e) => { if (e.key === "Enter") void save(); }} /></label>
        <label className="check"><input type="checkbox" checked={f.company} onChange={(e) => set("company", e.target.checked)} />Also save to the company library</label>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>{target ? "Add and use on this row" : "Add resource"}</button>
        <button className="btn" onClick={onClose}>Cancel</button>
      </div>
      {err && <div className="muted" role="alert" style={{ marginTop: 6, color: "var(--ink)", fontWeight: 600 }}>{err}</div>}
    </div>
  );
}
