import { useCallback, useEffect, useState } from "react";
import { costControl as K } from "@blackline/tender/core";
import { api, ApiError } from "../api.js";
import { type Action, type ActionHistory, none, record, stepBack, stepForward } from "../lib/actionHistory.js";
import { activitiesOf, type CostData, STATUS_TEXT, summaryOf } from "../lib/costWeb.js";
import type { ContactRow } from "../lib/enquiries.js";
import { money } from "../lib/fmt.js";
import { todayYmd } from "../lib/contractSetup.js";
import { hrefJob } from "../route.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";
import { CostClaims } from "./CostClaims.js";
import { CostLedgers } from "./CostLedgers.js";
import { CostVariations } from "./CostVariations.js";

export interface CostEnv {
  jobId: string;
  data: CostData;
  sum: K.CostSummary;
  canAdd: boolean;
  canManage: boolean;
  today: string;
  codes: { code: string; description: string }[];
  people: ContactRow[];
  reload(): Promise<void>;
  notify(kind: "info" | "warn", text: string): void;
  push(a: Action): void;
  /** Run a save, say what went wrong in words, and reload either way */
  act(fn: () => Promise<unknown>, ok?: string): Promise<void>;
  askVoid(kind: "commitments" | "actuals" | "claims", id: string, label: string): void;
}

type Tab = "summary" | "commitments" | "costs" | "variations" | "claims";
const TABS: { key: Tab; label: string }[] = [{ key: "summary", label: "Summary" }, { key: "commitments", label: "Orders" }, { key: "costs", label: "Costs" }, { key: "variations", label: "Variations" }, { key: "claims", label: "Claims" }];
const SEVERITY_BADGE = { Critical: "red", High: "solid", Medium: "grey", Low: "dashed" } as const;
export const say = (e: unknown, fallback: string) => (e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : fallback);

/**
 * Cost Control: an awarded job measured against its control budget. Orders placed, costs incurred, variations, the forecast of what is still to
 * come on each line, and claims on the client. The totals are the shared engine's, so they match the server. Entries are never edited or deleted:
 * a mistake is voided by a manager, with a reason, and stays in the ledger. Forecasts and the figures here are saved as they are made.
 */
export function CostControl({ ws, jobId }: { ws: Workspace; jobId: string }) {
  const { session } = useSession();
  const role = session!.role;
  const [data, setData] = useState<CostData | null>(null);
  const [notAwarded, setNotAwarded] = useState(false);
  const [people, setPeople] = useState<ContactRow[]>([]);
  const [tab, setTab] = useState<Tab>("summary");
  const [notice, setNotice] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [hist, setHist] = useState<ActionHistory>(none());
  const [voiding, setVoiding] = useState<{ kind: "commitments" | "actuals" | "claims"; id: string; label: string } | null>(null);
  const [reason, setReason] = useState("");

  const load = useCallback(async () => {
    try { setData(await api<CostData>("GET", `/jobs/${jobId}/cost`)); setNotAwarded(false); } catch (e) {
      if (e instanceof ApiError && e.code === "not_awarded") setNotAwarded(true);
      else setNotice({ kind: "warn", text: say(e, "Could not load cost control.") });
    }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { api<ContactRow[]>("GET", "/contacts").then((c) => setPeople(c.filter((x) => x.kind === "subcontractor" || x.kind === "supplier"))).catch(() => undefined); }, []);

  const step = async (dir: "back" | "forward") => {
    try {
      const r = await (dir === "back" ? stepBack(hist) : stepForward(hist));
      if (!r) return;
      setHist(r.history); await load(); setNotice({ kind: "info", text: `${dir === "back" ? "Undid" : "Redid"}: ${r.label}` });
    } catch (e) { setNotice({ kind: "warn", text: say(e, "That could not be saved, so nothing was changed.") }); }
  };

  if (notAwarded) {
    return (
      <div className="page sub-start">
        <h4>Cost Control</h4>
        <p className="muted">Cost control starts when the job is awarded: the control budget copied at award is what orders, costs and forecasts are measured against. Award the job in <a href={hrefJob(jobId, "contract")}>Contract Setup</a> first.</p>
      </div>
    );
  }
  if (!data) return <div className="docs">{notice ? <div className={`notice ${notice.kind}`} role="alert">{notice.text}</div> : <div className="empty">Loading…</div>}</div>;

  // the Gantt's tasks, so an activity that should have finished and hasn't can be warned about
  const gtask = new Map((ws.model?.ganttRows ?? []).map((r) => [r.task.uid, r.task]));
  const activities = activitiesOf((ws.model?.ganttSchedule?.tasks ?? []).map((t) => ({ wbs: t.wbs, name: gtask.get(t.uid)?.name ?? "", finish: t.finish, percent: t.percent, summary: t.summary, active: gtask.get(t.uid)?.active ?? true })));
  const sum = summaryOf(data, { today: todayYmd(), activities });
  const env: CostEnv = {
    jobId, data, sum, canAdd: role !== "viewer", canManage: role === "manager" || role === "owner", today: todayYmd(),
    codes: K.codesOf(data.contract.lines.map((l) => ({ code: l.code, description: l.description, section: l.section, amount: l.amount })), data.variations), people,
    reload: load, notify: (kind, text) => setNotice({ kind, text }), push: (a) => setHist((h) => record(h, a)),
    act: async (fn, ok) => { try { await fn(); if (ok) setNotice({ kind: "info", text: ok }); } catch (e) { setNotice({ kind: "warn", text: say(e, "That could not be saved.") }); } await load(); },
    askVoid: (kind, id, label) => { setVoiding({ kind, id, label }); setReason(""); },
  };

  const doVoid = async () => {
    if (!voiding) return;
    await env.act(() => api("POST", `/jobs/${jobId}/cost/${voiding.kind}/${voiding.id}/void`, { reason }), `Voided: ${voiding.label}. It stays in the ledger with your reason and counts for nothing.`);
    setVoiding(null);
  };

  const p = sum.project;
  const stat = (label: string, value: string, sub?: string, bad?: boolean) => <div className="stat"><span>{label}</span><strong className={bad ? "overdue" : ""}>{value}</strong>{sub && <small>{sub}</small>}</div>;

  return (
    <>
      <div className="strip">
        <button className="btn" disabled={hist.past.length === 0} onClick={() => void step("back")}>Undo</button>
        <button className="btn" disabled={hist.future.length === 0} onClick={() => void step("forward")}>Redo</button>
        <span className="muted">Saved as you go. A mistake is voided, never deleted, so the ledger stays complete.</span>
      </div>
      {notice && <div className={`notice ${notice.kind}`} role="alert">{notice.text}<button onClick={() => setNotice(null)}>Dismiss</button></div>}
      {voiding && (
        <div className="notice wrap ask" role="alert">
          <span>Void {voiding.label}? It stays in the ledger with your reason and counts for nothing.</span>
          <input autoFocus value={reason} placeholder="Why" aria-label="Reason for voiding" style={{ flex: 1, minWidth: 220 }} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doVoid(); }} />
          <button className="btn primary" onClick={() => void doVoid()}>Void it</button>
          <button className="btn" onClick={() => setVoiding(null)}>Cancel</button>
        </div>
      )}
      <div className="pipeline">
        {TABS.map((t) => <button key={t.key} className={`chip${tab === t.key ? " on" : ""}`} onClick={() => setTab(t.key)}>{t.label}
          {t.key === "variations" && sum.pending.count > 0 && <small> {sum.pending.count} pending</small>}</button>)}
        <span className="muted" style={{ marginLeft: "auto" }}>Awarded {data.contract.awardedOn} from {data.contract.revision.label}</span>
      </div>

      <div className="docs">
        {tab === "summary" && (
          <>
            <div className="stats">
              {stat("Contract sum", `$${money(p.currentContractValue)}`, p.approvedVariationsSell.isZero() ? "as awarded" : `incl. $${money(p.approvedVariationsSell)} of variations`)}
              {stat("Budget (cost)", `$${money(p.revisedBudget)}`, `$${money(p.budgetRemaining)} left after orders and costs`, p.budgetRemaining.lt(0))}
              {stat("Spent", `$${money(p.actualCostToDate)}`, `$${money(p.committedCost)} still on order`)}
              {stat("Forecast final cost", `$${money(p.forecastFinalCost)}`, p.costVariance.lt(0) ? `$${money(p.costVariance.neg())} over budget` : `$${money(p.costVariance)} under budget`, p.costVariance.lt(0))}
              {stat("Forecast margin", `${p.forecastFinalMarginPct}%`, `$${money(p.forecastFinalProfit)} · was ${p.originalMarginPct}% at award`, p.marginDrift.lt(0))}
              {stat("Claimed", `${sum.claimed.pctOfContract}%`, `$${money(sum.claimed.value)} · $${money(sum.claimed.outstanding)} owing`)}
            </div>
            {sum.pending.count > 0 && <div className="notice warn">{sum.pending.count} variation{sum.pending.count === 1 ? "" : "s"} waiting for a decision: ${money(sum.pending.sell)} to sell, ${money(sum.pending.cost)} of cost. Not in the figures above until approved.</div>}
            {sum.warnings.length > 0 && (
              <section>
                <h3>To look at <span className="sub">{sum.warnings.length} · most serious first</span></h3>
                <div className="sub-pad">
                  {sum.warnings.map((w, i) => (
                    <div key={`${w.warning_type}-${i}`} className={`gate${w.severity === "Critical" || w.severity === "High" ? " block" : ""}`}>
                      <span className={`badge ${SEVERITY_BADGE[w.severity]}`}>{w.severity}</span> <strong>{w.title}</strong>
                      <div>{w.description}</div>
                      <div className="muted">{w.suggested_action}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}
            <SummaryLines env={env} />
          </>
        )}
        {tab === "commitments" && <CostLedgers env={env} mode="commitments" />}
        {tab === "costs" && <CostLedgers env={env} mode="costs" />}
        {tab === "variations" && <CostVariations env={env} />}
        {tab === "claims" && <CostClaims env={env} />}
      </div>
    </>
  );
}

function SummaryLines({ env }: { env: CostEnv }) {
  const { sum, data } = env;
  const save = async (code: string, value: string, was: string) => {
    if (value.trim().replace(/[,$]/g, "") === was) return;
    await env.act(async () => {
      await api("POST", `/jobs/${env.jobId}/cost/forecast`, { code, etc: value });
      env.push({ label: `Forecast for ${code}`, undo: async () => { await api("POST", `/jobs/${env.jobId}/cost/forecast`, { code, etc: was }); }, redo: async () => { await api("POST", `/jobs/${env.jobId}/cost/forecast`, { code, etc: value }); } });
    });
  };
  const manual = new Map(data.forecasts.map((f) => [f.code, f.etc]));
  return (
    <section>
      <h3>Every line against its budget <span className="sub">type what is still to come on a line to change its forecast; clear it to go back to the budget</span></h3>
      <div className="tablewrap">
        <table className="plain reg" style={{ minWidth: 1100 }}>
          <thead>
            <tr><th style={{ width: 80 }}>Code</th><th>Description</th><th className="r" style={{ width: 100 }}>Budget $</th><th className="r" style={{ width: 90 }}>Variations $</th><th className="r" style={{ width: 100 }}>Revised $</th>
              <th className="r" style={{ width: 100 }}>Spent $</th><th className="r" style={{ width: 100 }}>On order $</th><th className="r" style={{ width: 120 }}>Still to come $</th><th className="r" style={{ width: 110 }}>Forecast final $</th>
              <th className="r" style={{ width: 100 }}>Over / under $</th><th style={{ width: 90 }}>Standing</th></tr>
          </thead>
          <tbody>
            {sum.lines.map((l) => {
              const was = manual.get(l.code) ?? "";
              return (
                <tr key={l.code}>
                  <td>{l.code}</td><td>{l.description}</td>
                  <td className="r">{money(l.original)}</td><td className="r">{l.variations.isZero() ? "" : money(l.variations)}</td><td className="r">{money(l.revised)}</td>
                  <td className="r">{money(l.actual)}</td><td className="r">{l.committed.isZero() ? "" : money(l.committed)}</td>
                  <td><input key={was} defaultValue={was ? money(was) : ""} placeholder={money(l.etc)} disabled={!env.canAdd} aria-label={`Still to come on ${l.code}`} style={{ textAlign: "right" }}
                    onBlur={(e) => void save(l.code, e.target.value, was)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></td>
                  <td className="r"><strong>{money(l.forecastFinal)}</strong></td>
                  <td className={`r${l.variance.lt(0) ? " overdue" : ""}`}>{l.variance.isZero() ? "" : `${l.variance.gt(0) ? "+" : ""}${money(l.variance)}`}</td>
                  <td><span className={`badge ${l.status === "Over Budget" ? "red" : l.status === "Watch" ? "grey" : "dashed"}`}>{STATUS_TEXT[l.status]}</span></td>
                </tr>
              );
            })}
            <tr className="total"><td colSpan={2}>Total</td><td className="r">{money(sum.project.originalBudget)}</td><td className="r">{money(sum.project.revisedBudget.minus(sum.project.originalBudget))}</td><td className="r">{money(sum.project.revisedBudget)}</td>
              <td className="r">{money(sum.project.actualCostToDate)}</td><td className="r">{money(sum.project.committedCost)}</td><td className="r">{money(sum.project.forecastCostToComplete)}</td><td className="r">{money(sum.project.forecastFinalCost)}</td>
              <td className="r">{money(sum.project.costVariance)}</td><td /></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}
