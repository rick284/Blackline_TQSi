import { useState } from "react";
import { api } from "../api.js";
import { money } from "../lib/fmt.js";
import type { CostEnv } from "./CostControl.js";

const dateText = (ymd: string | null) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");

/**
 * Payment claims on the client: the value of work claimed, the retention held back at the percentage in the contract terms when the claim was made, GST,
 * and what has been paid. A draft hasn't gone to the client, so it isn't counted as claimed. A manager makes and moves claims.
 */
export function CostClaims({ env }: { env: CostEnv }) {
  const { sum, data } = env;
  const [f, setF] = useState({ periodEnd: env.today, valueEx: "", note: "" });
  const [step, setStep] = useState<{ id: string; seq: number; to: "submitted" | "paid"; on: string; amount: string } | null>(null);
  const c = sum.claimed;
  const noteOf = new Map(data.claims.map((x) => [x.id, x]));

  const add = () => env.act(async () => { await api("POST", `/jobs/${env.jobId}/cost/claims`, f); setF({ ...f, valueEx: "", note: "" }); }, "Claim recorded as a draft.");
  const move = () => step && env.act(async () => { await api("POST", `/jobs/${env.jobId}/cost/claims/${step.id}`, { status: step.to, on: step.on, ...(step.to === "paid" ? { paidAmount: step.amount } : {}) }); setStep(null); },
    step.to === "submitted" ? `Claim ${step.seq} marked as submitted.` : `Claim ${step.seq} marked as paid.`);
  const retention = data.contract.terms.retentionPct;

  return (
    <>
      <div className="stats">
        <div className="stat"><span>Claimed</span><strong>${money(c.value)}</strong><small>{c.pctOfContract.toString()}% of the contract sum</small></div>
        <div className="stat"><span>Retention held</span><strong>${money(c.retentionHeld)}</strong><small>{retention ? `${retention}% in the contract terms` : "none set in the contract terms"}</small></div>
        <div className="stat"><span>Owed by the client</span><strong>${money(c.netInc)}</strong><small>after retention, including GST</small></div>
        <div className="stat"><span>Received</span><strong>${money(c.paid)}</strong></div>
        <div className="stat"><span>Still owing</span><strong className={c.outstanding.gt(0) ? "overdue" : ""}>${money(c.outstanding)}</strong></div>
      </div>
      <section>
        <h3>Payment claims</h3>
        <div className="tablewrap">
          <table className="plain reg" style={{ minWidth: 1100 }}>
            <thead><tr><th style={{ width: 50 }}>No.</th><th style={{ width: 120 }}>Claim date</th><th className="r" style={{ width: 120 }}>Value $</th><th className="r" style={{ width: 120 }}>To date $</th><th className="r" style={{ width: 110 }}>Retention $</th>
              <th className="r" style={{ width: 120 }}>Net excl. GST $</th><th className="r" style={{ width: 120 }}>Net incl. GST $</th><th style={{ width: 130 }}>Status</th><th>Note</th><th style={{ width: 200 }} /></tr></thead>
            <tbody>
              {env.canManage && (
                <tr className="new">
                  <td className="muted">New</td>
                  <td><input type="date" value={f.periodEnd} aria-label="Claim date" onChange={(e) => setF({ ...f, periodEnd: e.target.value })} /></td>
                  <td><input value={f.valueEx} placeholder="0.00" aria-label="Claim value" style={{ textAlign: "right" }} onChange={(e) => setF({ ...f, valueEx: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /></td>
                  <td colSpan={5} className="muted">The value of work done this period, excluding GST. Retention at {retention || "0"}% is taken off.</td>
                  <td><input value={f.note} placeholder="Note" aria-label="Claim note" onChange={(e) => setF({ ...f, note: e.target.value })} /></td>
                  <td><button className="btn" disabled={!f.valueEx.trim()} onClick={() => void add()}>Add claim</button></td>
                </tr>
              )}
              {sum.claims.map((x) => (
                <tr key={x.id}>
                  <td>{x.seq}</td><td>{dateText(x.periodEnd)}</td><td className="r">{money(x.value)}</td><td className="r muted">{money(x.cumulativeValue)}</td>
                  <td className="r">{x.retention.isZero() ? "" : money(x.retention)}<span className="muted"> {x.retentionPct && x.retentionPct !== "0" ? `${x.retentionPct}%` : ""}</span></td>
                  <td className="r">{money(x.netEx)}</td><td className="r">{money(x.netInc)}</td>
                  <td><span className={`badge ${x.status === "paid" ? "solid" : x.status === "submitted" ? "grey" : "dashed"}`}>{x.status === "draft" ? "Draft" : x.status === "submitted" ? "Submitted" : "Paid"}</span>
                    <div className="muted">{x.status === "submitted" ? dateText(noteOf.get(x.id)?.submittedOn ?? null) : x.status === "paid" ? `${dateText(noteOf.get(x.id)?.paidOn ?? null)} · $${money(x.paid)}` : ""}</div></td>
                  <td className="muted">{noteOf.get(x.id)?.note}</td>
                  <td className="acts">
                    {env.canManage && x.status === "draft" && <button className="btn primary" onClick={() => setStep({ id: x.id, seq: x.seq, to: "submitted", on: env.today, amount: "" })}>Submitted…</button>}
                    {env.canManage && x.status === "submitted" && <button className="btn primary" onClick={() => setStep({ id: x.id, seq: x.seq, to: "paid", on: env.today, amount: x.netInc.toFixed(2) })}>Paid…</button>}
                    {env.canManage && <button className="btn" onClick={() => env.askVoid("claims", x.id, `claim ${x.seq}`)}>Void</button>}
                  </td>
                </tr>
              ))}
              {sum.claims.length === 0 && <tr><td colSpan={10} className="muted">No claims yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {step && (
          <div className="notice wrap ask" role="alert">
            <span>{step.to === "submitted" ? `Claim ${step.seq} went to the client on` : `Claim ${step.seq} was paid on`}</span>
            <input type="date" value={step.on} aria-label="Date" onChange={(e) => setStep({ ...step, on: e.target.value })} />
            {step.to === "paid" && <><span>for $</span><input value={step.amount} aria-label="Amount received" style={{ width: 130, textAlign: "right" }} onChange={(e) => setStep({ ...step, amount: e.target.value })} /><span className="muted">including GST</span></>}
            <button className="btn primary" onClick={() => void move()}>{step.to === "submitted" ? "Mark submitted" : "Mark paid"}</button>
            <button className="btn" onClick={() => setStep(null)}>Cancel</button>
          </div>
        )}
      </section>
    </>
  );
}
