import { useState } from "react";
import { api } from "../api.js";
import { variationLines } from "../lib/costWeb.js";
import { money } from "../lib/fmt.js";
import type { CostEnv } from "./CostControl.js";

type Row = { code: string; description: string; amount: string };
const BLANK = () => ({ id: null as string | null, title: "", sell: "", note: "", submittedOn: "", responseDue: "", atRisk: false, lines: [{ code: "", description: "", amount: "" }] as Row[] });
const BADGE = { pending: "grey", approved: "solid", rejected: "dashed" } as const;
const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-NZ", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * Variations: changes the client asks for or agrees to. A variation has a sell amount and the cost lines it adds or removes. Only an approved one moves the
 * budget and the contract sum; a pending one is shown beside them. A manager decides, and the decision is final.
 */
export function CostVariations({ env }: { env: CostEnv }) {
  const [f, setF] = useState(BLANK());
  const [ask, setAsk] = useState<{ id: string; ref: string; decision: "approved" | "rejected" } | null>(null);
  const [note, setNote] = useState("");
  const known = new Set(env.codes.map((c) => c.code));

  const setLine = (i: number, patch: Partial<Row>) => setF((s) => ({ ...s, lines: s.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const save = () => env.act(async () => {
    const body = { title: f.title, sell: f.sell, note: f.note, submittedOn: f.submittedOn, responseDue: f.responseDue, atRisk: f.atRisk, lines: variationLines(f.lines) };
    if (f.id) await api("POST", `/jobs/${env.jobId}/cost/variations/${f.id}`, body);
    else await api("POST", `/jobs/${env.jobId}/cost/variations`, body);
    setF(BLANK());
  }, f.id ? "Variation updated." : "Variation recorded as pending. It moves nothing until a manager approves it.");
  const decide = () => ask && env.act(async () => { await api("POST", `/jobs/${env.jobId}/cost/variations/${ask.id}/decision`, { decision: ask.decision, note }); setAsk(null); setNote(""); },
    ask.decision === "approved" ? `${ask.ref} approved: the contract sum and budget now include it.` : `${ask.ref} rejected, with your reason kept.`);

  return (
    <>
      {ask && (
        <div className="notice wrap ask" role="alert">
          <span>{ask.decision === "approved" ? `Approve ${ask.ref}? The contract sum and the budget change, and the decision can't be undone.` : `Reject ${ask.ref}? Say why; the reason is kept and the decision can't be undone.`}</span>
          <input autoFocus value={note} placeholder={ask.decision === "approved" ? "Note (how it was agreed)" : "Reason"} aria-label="Decision note" style={{ flex: 1, minWidth: 220 }} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void decide(); }} />
          <button className="btn primary" onClick={() => void decide()}>{ask.decision === "approved" ? "Approve" : "Reject"}</button>
          <button className="btn" onClick={() => setAsk(null)}>Cancel</button>
        </div>
      )}
      {env.canAdd && (
        <section>
          <h3>{f.id ? "Change this variation" : "Record a variation"} <span className="sub">what the client will pay, and the cost it adds or removes</span></h3>
          <div className="sub-pad">
            <div className="revform">
              <label className="grow">Title<input value={f.title} placeholder="Extra kerb and channel" aria-label="Variation title" onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
              <label>Sell $ (excl. GST)<input value={f.sell} placeholder="3000" aria-label="Variation sell" style={{ width: 130, textAlign: "right" }} onChange={(e) => setF({ ...f, sell: e.target.value })} /></label>
              <label className="grow">Note<input value={f.note} placeholder="Client email 2 Nov" aria-label="Variation note" onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
            </div>
            <div className="revform">
              <label>Sent to the client<input type="date" value={f.submittedOn} aria-label="Variation sent on" onChange={(e) => setF({ ...f, submittedOn: e.target.value })} /></label>
              <label>Reply due by<input type="date" value={f.responseDue} aria-label="Variation reply due" onChange={(e) => setF({ ...f, responseDue: e.target.value })} /></label>
              <label style={{ flexDirection: "row", alignItems: "center", gap: 6, color: "var(--ink)", fontSize: 12 }}>
                <input type="checkbox" checked={f.atRisk} aria-label="Work started without approval" onChange={(e) => setF({ ...f, atRisk: e.target.checked })} style={{ width: "auto", height: "auto" }} /> Work has started without approval
              </label>
              <span className="muted">These drive the warnings: a reply that is overdue, and work going ahead at risk.</span>
            </div>
            <table className="plain reg" style={{ minWidth: 0, maxWidth: 900 }}>
              <thead><tr><th style={{ width: 150 }}>Budget line</th><th>Description (needed for a new line)</th><th className="r" style={{ width: 130 }}>Cost $ (less: -)</th><th style={{ width: 70 }} /></tr></thead>
              <tbody>
                {f.lines.map((l, i) => (
                  <tr key={i}>
                    <td><input list="var-codes" value={l.code} placeholder="EW01 or a new code" aria-label={`Cost line ${i + 1} code`} onChange={(e) => setLine(i, { code: e.target.value.trim() })} />
                      {i === 0 && <datalist id="var-codes">{env.codes.map((c) => <option key={c.code} value={c.code}>{c.description}</option>)}</datalist>}</td>
                    <td><input value={l.description} placeholder={l.code && !known.has(l.code) ? "What this new line is" : env.codes.find((c) => c.code === l.code)?.description ?? ""} aria-label={`Cost line ${i + 1} description`} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
                    <td><input value={l.amount} placeholder="0.00" aria-label={`Cost line ${i + 1} amount`} style={{ textAlign: "right" }} onChange={(e) => setLine(i, { amount: e.target.value })} /></td>
                    <td><button className="btn" onClick={() => setF((s) => ({ ...s, lines: s.lines.length > 1 ? s.lines.filter((_, j) => j !== i) : [{ code: "", description: "", amount: "" }] }))}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={() => setF((s) => ({ ...s, lines: [...s.lines, { code: "", description: "", amount: "" }] }))}>Add a cost line</button>
              <button className="btn primary" disabled={!f.title.trim() || !f.sell.trim()} onClick={() => void save()}>{f.id ? "Save changes" : "Record variation"}</button>
              {f.id && <button className="btn" onClick={() => setF(BLANK())}>Cancel</button>}
            </div>
          </div>
        </section>
      )}
      <section>
        <h3>Variations <span className="sub">{env.data.variations.length}</span></h3>
        <div className="tablewrap">
          <table className="plain reg" style={{ minWidth: 900 }}>
            <thead><tr><th style={{ width: 70 }}>No.</th><th>Variation</th><th className="r" style={{ width: 120 }}>Sell $</th><th className="r" style={{ width: 120 }}>Cost $</th><th style={{ width: 110 }}>Status</th><th style={{ width: 230 }}>Decision</th><th style={{ width: 230 }} /></tr></thead>
            <tbody>
              {env.data.variations.map((v) => {
                const cost = v.lines.reduce((t, l) => t + Number(l.amount), 0).toFixed(2);
                return (
                  <tr key={v.id}>
                    <td>{v.ref}</td>
                    <td><strong>{v.title}</strong>{v.atRisk && v.status === "pending" && <span className="badge solid" style={{ marginLeft: 8 }}>Work started at risk</span>}
                      <div className="muted">{v.lines.map((l) => `${l.code} ${Number(l.amount) < 0 ? "−" : ""}${money(Math.abs(Number(l.amount)).toFixed(2))}`).join(" · ")}{v.note ? ` · ${v.note}` : ""}</div>
                      {(v.submittedOn || v.responseDue) && <div className="muted">{v.submittedOn ? `Sent ${day(v.submittedOn)}` : ""}{v.submittedOn && v.responseDue ? " · " : ""}{v.responseDue ? `reply due ${day(v.responseDue)}` : ""}</div>}</td>
                    <td className="r">{money(v.sell)}</td><td className="r">{money(cost)}</td>
                    <td><span className={`badge ${BADGE[v.status]}`}>{v.status === "pending" ? "Pending" : v.status === "approved" ? "Approved" : "Rejected"}</span></td>
                    <td className="muted">{v.decidedBy ? `${v.decidedBy}${v.decisionNote ? `: ${v.decisionNote}` : ""}` : ""}</td>
                    <td className="acts">
                      {v.status === "pending" && env.canAdd && <button className="btn" onClick={() => { setF({ id: v.id, title: v.title, sell: v.sell, note: v.note, submittedOn: v.submittedOn ?? "", responseDue: v.responseDue ?? "", atRisk: !!v.atRisk, lines: v.lines.length ? v.lines.map((l) => ({ ...l })) : [{ code: "", description: "", amount: "" }] }); window.scrollTo?.(0, 0); }}>Edit</button>}
                      {v.status === "pending" && env.canManage && <>
                        <button className="btn primary" onClick={() => { setAsk({ id: v.id, ref: v.ref, decision: "approved" }); setNote(""); }}>Approve</button>
                        <button className="btn" onClick={() => { setAsk({ id: v.id, ref: v.ref, decision: "rejected" }); setNote(""); }}>Reject</button></>}
                    </td>
                  </tr>
                );
              })}
              {env.data.variations.length === 0 && <tr><td colSpan={7} className="muted">No variations yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
