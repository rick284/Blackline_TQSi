import { Fragment, useCallback, useEffect, useState } from "react";
import { contract as C } from "@blackline/tender/core";
import { api, ApiError } from "../api.js";
import { type ActionHistory, none, record, stepBack, stepForward } from "../lib/actionHistory.js";
import { budgetCsv, previewBudget, todayYmd, type Budget } from "../lib/contractSetup.js";
import { money } from "../lib/fmt.js";
import { hrefJob } from "../route.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";

interface Rev { id: string; seq: number; label: string; issuedAt: string; totals: Record<string, string>; supersededByLabel: string | null; verified: boolean }
interface Contract {
  id: string; revision: { id: string; label: string; issuedAt: string; superseded: boolean; verified: boolean }; awardedOn: string; awardedBy: string;
  contractSum: string; tenderAllIn: string; terms: C.Terms; lines: C.BudgetLine[]; budget: { cost: string; margin: string; marginPct: string };
}

const say = (e: unknown, fallback: string) => (e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : fallback);
const when = (iso: string) => new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
const day = (ymd: string) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");

const FIELDS: { key: keyof C.Terms; label: string; kind?: "date" | "select" | "area"; wide?: boolean; hint?: string }[] = [
  { key: "form", label: "Contract form", kind: "select" },
  { key: "contractNumber", label: "Contract number" },
  { key: "clientRef", label: "Client's reference" },
  { key: "startDate", label: "Start", kind: "date" },
  { key: "completionDate", label: "Practical completion", kind: "date" },
  { key: "claimDay", label: "Payment claim day", hint: "for example 25th" },
  { key: "payDays", label: "Payment due (working days after claim)", hint: "as the contract says" },
  { key: "retentionPct", label: "Retention held (%)" },
  { key: "defectsMonths", label: "Defects liability (months)" },
  { key: "ldPerDay", label: "Liquidated damages ($ per day)" },
  { key: "retentionNote", label: "Retention release", wide: true, hint: "when and how it is released" },
  { key: "notes", label: "Notes on the contract", wide: true, kind: "area" },
];

/**
 * Contract Setup: awarding a job. The issued revision stays exactly as the client received it; awarding copies the cost it carried into the control
 * budget, line by line, and records the contract sum and terms. The budget is what Cost Control will measure against, so it is never edited:
 * changes after award will be variations. Only a manager awards, and only a job whose tender has been issued.
 */
export function ContractSetup({ ws, jobId }: { ws: Workspace; jobId: string }) {
  const { session } = useSession();
  const canAward = session!.role === "manager" || session!.role === "owner";

  const [revs, setRevs] = useState<Rev[] | null>(null);
  const [contract, setContract] = useState<Contract | null | undefined>(undefined);
  const [notice, setNotice] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [hist, setHist] = useState<ActionHistory>(none());
  const [pick, setPick] = useState("");
  const [preview, setPreview] = useState<Budget | null>(null);
  const [sum, setSum] = useState("");
  const [on, setOn] = useState(todayYmd());
  const [terms, setTerms] = useState<Partial<C.Terms>>({});
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, r] = await Promise.all([api<{ contract: Contract | null }>("GET", `/jobs/${jobId}/contract`), api<Rev[]>("GET", `/jobs/${jobId}/revisions`)]);
      setContract(c.contract); setRevs(r);
      setPick((p) => p || r[0]?.id || "");
    } catch (e) { setNotice({ kind: "warn", text: say(e, "Could not load the contract.") }); }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!pick || contract) { setPreview(null); return; }
    let live = true;
    api<{ records: { id: string; data: unknown }[] }>("GET", `/revisions/${pick}/records`).then((r) => { if (live) setPreview(previewBudget(r.records)); }).catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [pick, contract]);

  const award = async () => {
    setBusy(true);
    try {
      const c = await api<Contract>("POST", `/jobs/${jobId}/award`, { revisionId: pick, ...(sum.trim() ? { contractSum: sum } : {}), awardedOn: on, terms });
      setContract(c); setAsk(false); setNotice({ kind: "info", text: `Awarded. The control budget of $${money(c.budget.cost)} is copied from ${c.revision.label} and can't be edited; changes from here are variations.` });
      await ws.load();
    } catch (e) { setNotice({ kind: "warn", text: say(e, "The award could not be saved.") }); setAsk(false); }
    setBusy(false);
  };

  const saveTerm = async (field: keyof C.Terms, value: string) => {
    if (!contract) return;
    const back = contract.terms[field];
    if (value.trim() === back) return;
    try {
      const next = await api<Contract>("POST", `/jobs/${jobId}/contract`, { [field]: value });
      setContract(next);
      const label = FIELDS.find((f) => f.key === field)!.label;
      setHist((h) => record(h, { label, undo: async () => { setContract(await api<Contract>("POST", `/jobs/${jobId}/contract`, { [field]: back })); }, redo: async () => { setContract(await api<Contract>("POST", `/jobs/${jobId}/contract`, { [field]: value })); } }));
    } catch (e) { setNotice({ kind: "warn", text: say(e, "That could not be saved.") }); await load(); }
  };

  const step = async (dir: "back" | "forward") => {
    try {
      const r = await (dir === "back" ? stepBack(hist) : stepForward(hist));
      if (!r) return;
      setHist(r.history); setNotice({ kind: "info", text: `${dir === "back" ? "Undid" : "Redid"}: ${r.label}` });
    } catch (e) { setNotice({ kind: "warn", text: say(e, "That could not be saved, so nothing was changed.") }); }
  };

  const download = () => {
    if (!contract) return;
    const blob = new Blob([budgetCsv("Control budget", contract.lines, { contractSum: contract.contractSum, cost: contract.budget.cost, margin: contract.budget.margin })], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "control-budget.csv";
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const termsFields = (values: Partial<C.Terms>, disabled: boolean, onCommit: (k: keyof C.Terms, v: string) => void, keyed: boolean) => (
    <div className="sub-form" style={{ maxWidth: 900 }}>
      {FIELDS.map((f) => (
        <label key={f.key} className={f.wide ? "wide" : ""}>
          <span>{f.label}</span>
          {f.kind === "select" ? (
            <select value={values[f.key] ?? ""} disabled={disabled} aria-label={f.label} onChange={(e) => onCommit(f.key, e.target.value)}>
              <option value="">Not recorded</option>{C.FORMS.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          ) : f.kind === "area" ? (
            <textarea key={keyed ? values[f.key] : undefined} defaultValue={values[f.key] ?? ""} rows={3} disabled={disabled} aria-label={f.label} onBlur={(e) => onCommit(f.key, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          ) : (
            <input key={keyed ? values[f.key] : undefined} type={f.kind === "date" ? "date" : "text"} defaultValue={values[f.key] ?? ""} disabled={disabled} placeholder={f.hint} aria-label={f.label}
              onBlur={(e) => onCommit(f.key, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          )}
        </label>
      ))}
    </div>
  );

  const budgetTable = (lines: C.BudgetLine[], totals: { cost: string; contractSum: string; margin: string; marginPct?: string }) => {
    const sections = C.bySection(lines);
    return (
      <table className="plain reg" style={{ minWidth: 0 }}>
        <thead><tr><th style={{ width: 90 }}>Code</th><th>Description</th><th style={{ width: 110 }}>Kind</th><th className="r" style={{ width: 130 }}>Budget $</th></tr></thead>
        <tbody>
          {sections.map((s) => (
            <Fragment key={s.section}>
              <tr className="grp"><td colSpan={3}><strong>{s.section}</strong> <span className="muted">{s.lines} line{s.lines === 1 ? "" : "s"}</span></td><td className="r"><strong>{money(s.amount)}</strong></td></tr>
              {lines.filter((l) => l.section === s.section).map((l) => <tr key={l.code}><td>{l.code}</td><td>{l.description}</td><td className="muted">{l.kind === "qs" ? "Work item" : l.kind === "allowance" ? "Allowance" : "Subcontract"}</td><td className="r">{money(l.amount)}</td></tr>)}
            </Fragment>
          ))}
          <tr className="total"><td colSpan={3}>Control budget (cost)</td><td className="r">{money(totals.cost)}</td></tr>
          <tr className="sub"><td colSpan={3}>Margin held in the contract sum{totals.marginPct ? ` (${totals.marginPct}% of the sum)` : ""}</td><td className="r">{money(totals.margin)}</td></tr>
          <tr className="total"><td colSpan={3}>Contract sum excluding GST</td><td className="r">{money(totals.contractSum)}</td></tr>
        </tbody>
      </table>
    );
  };

  if (contract === undefined || revs === null) return <div className="docs">{notice ? <div className={`notice ${notice.kind}`} role="alert">{notice.text}</div> : <div className="empty">Loading…</div>}</div>;

  const noticeBar = notice && <div className={`notice ${notice.kind}`} role="alert">{notice.text}<button onClick={() => setNotice(null)}>Dismiss</button></div>;

  // ---- awarded
  if (contract) {
    const c = contract;
    return (
      <>
        <div className="strip">
          <button className="btn" disabled={hist.past.length === 0} onClick={() => void step("back")}>Undo</button>
          <button className="btn" disabled={hist.future.length === 0} onClick={() => void step("forward")}>Redo</button>
          <span className="muted">{canAward ? "Terms are saved as you edit them." : "You can look but not change anything."}</span>
        </div>
        {noticeBar}
        <div className="docs">
          <div className="pipeline" style={{ gap: 24 }}>
            <span><strong>Awarded</strong> {day(c.awardedOn)} by {c.awardedBy}</span>
            <span>from <strong>{c.revision.label}</strong>{c.revision.superseded ? " (a later revision was issued)" : ""}{c.revision.verified ? "" : " · NO LONGER MATCHES WHAT WAS ISSUED"}</span>
            <span>Contract sum <strong>${money(c.contractSum)}</strong></span>
            {c.contractSum !== c.tenderAllIn && <span className="muted">tender was ${money(c.tenderAllIn)}</span>}
          </div>
          <section>
            <h3>Control budget <span className="sub">${money(c.budget.cost)} cost · ${money(c.budget.margin)} margin ({c.budget.marginPct}%) · copied at award, never edited</span>
              <button className="btn" style={{ marginLeft: "auto" }} onClick={download}>Download as CSV</button></h3>
            <div className="tablewrap" style={{ margin: "8px 12px" }}>{budgetTable(c.lines, { cost: c.budget.cost, contractSum: c.contractSum, margin: c.budget.margin, marginPct: c.budget.marginPct })}</div>
          </section>
          <section>
            <h3>Contract terms</h3>
            <div style={{ margin: "8px 12px" }}>{termsFields(c.terms, !canAward, (k, v) => void saveTerm(k, v), true)}</div>
          </section>
        </div>
      </>
    );
  }

  // ---- not awarded yet
  const rev = revs.find((r) => r.id === pick);
  return (
    <>
      {noticeBar}
      {ask && rev && preview && (
        <div className="notice wrap ask" role="alert">
          <span>Award this job from {rev.label}? The control budget of ${money(preview.cost)} is copied from it and can't be edited afterwards. The contract sum will be ${money(sum.trim() ? sum.replace(/[,$]/g, "") : preview.allIn)}.</span>
          <button className="btn primary" disabled={busy} onClick={() => void award()}>Award the job</button>
          <button className="btn" onClick={() => setAsk(false)}>Cancel</button>
        </div>
      )}
      <div className="docs">
        {revs.length === 0 ? (
          <div className="page">
            <h4>Contract Setup</h4>
            <p className="muted">A job can be awarded once its tender has been issued. Issue the tender from <a href={hrefJob(jobId, "submission")}>Submission</a> first.</p>
          </div>
        ) : (
          <>
            <section>
              <h3>Award this job <span className="sub">the tender is frozen as issued; the award copies its cost into the control budget</span></h3>
              <div className="sub-pad">
                <div className="sub-form" style={{ maxWidth: 900 }}>
                  <label><span>Awarded from</span>
                    <select value={pick} aria-label="Revision awarded from" onChange={(e) => setPick(e.target.value)}>
                      {revs.map((r) => <option key={r.id} value={r.id}>{r.label} · issued {when(r.issuedAt)} · ${money(r.totals.allIn)}{r.supersededByLabel ? " (superseded)" : ""}</option>)}
                    </select></label>
                  <label><span>Date awarded</span><input type="date" value={on} aria-label="Date awarded" onChange={(e) => setOn(e.target.value)} /></label>
                  <label className="wide"><span>Contract sum excluding GST: leave blank for the tender price{preview ? ` ($${money(preview.allIn)})` : ""}</span>
                    <input value={sum} placeholder={preview ? money(preview.allIn) : ""} aria-label="Contract sum" onChange={(e) => setSum(e.target.value)} /></label>
                </div>
                {rev?.supersededByLabel && <p className="muted">{rev.label} has been superseded. That is fine if it is the one the client accepted.</p>}
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button className="btn primary" disabled={!canAward || !preview || busy} onClick={() => { setAsk(true); window.scrollTo?.(0, 0); }} title={canAward ? "" : "Awarding needs the manager role"}>Award this job…</button>
                  {!canAward && <span className="muted">Awarding needs the manager role.</span>}
                  <span className="muted">Terms below are optional now. The budget this copies is listed at the bottom.</span>
                </div>
              </div>
            </section>
            <section>
              <h3>Contract terms <span className="sub">optional now; can be filled in or changed after award</span></h3>
              <div style={{ margin: "8px 12px" }}>{termsFields(terms, !canAward, (k, v) => setTerms((t) => ({ ...t, [k]: v })), false)}</div>
            </section>
            <section>
              <h3>Control budget this award would copy {preview ? <span className="sub">${money(preview.cost)} cost · ${money(preview.margin)} margin</span> : null}</h3>
              <div className="tablewrap" style={{ margin: "8px 12px" }}>
                {preview ? budgetTable(preview.lines, { cost: preview.cost, contractSum: sum.trim() ? sum.replace(/[,$]/g, "") : preview.allIn, margin: (Number(sum.trim() ? sum.replace(/[,$]/g, "") : preview.allIn) - Number(preview.cost)).toFixed(2) }) : <p className="muted">Working it out…</p>}
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
