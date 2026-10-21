import { useCallback, useEffect, useRef, useState } from "react";
import { assembleInputs, computeTenderEstimate, diffEstimates, submission as SUB, type DisplayEstimate } from "@blackline/tender/core";
import { api, ApiError } from "../api.js";
import { money, pct } from "../lib/fmt.js";
import { newAlternative, newQualification, setAltField, setLetterField, setQualField, type Alternative, type Letter, type Qualification } from "../lib/submission.js";
import { hrefJob, type View } from "../route.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";
import { PackageBar } from "./PackageBar.js";

interface Rev {
  id: string; seq: number; label: string; note: string; issuedBy: string; issuedAt: string; totals: Record<string, string>;
  overrides: { text: string; reason: string }[]; supersededByLabel: string | null; verified: boolean;
}
type Diff = ReturnType<typeof diffEstimates>;
interface Comparison { title: string; a: string; b: string; diff: Diff }

const when = (iso: string) => new Date(iso).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const WHERE: Record<string, { view: View; label: string }> = {
  scope: { view: "scope", label: "Scope Register" }, estimate: { view: "estimate", label: "Estimate" }, commercial: { view: "commercial", label: "Commercial Review" },
  summary: { view: "summary", label: "Summary" }, risk: { view: "estimate", label: "Estimate" },
};

async function displayOfRevision(id: string): Promise<DisplayEstimate> {
  const r = await api<{ records: { id: string; data: any }[] }>("GET", `/revisions/${id}/records`);
  const inputs = assembleInputs(r.records);
  return SUB.displayOf(computeTenderEstimate(inputs), inputs);
}

/**
 * Submission: the tender letter, its qualifications and alternatives, and issuing the tender as a frozen revision. A revision is the whole job
 * exactly as it was when sent; it is never edited, only superseded by the next one, and it can be set beside the previous revision or the work
 * now to see what moved. A tender can't issue while scope is flagged, a build-up row has no rate, or the client schedule doesn't add up; an owner
 * can issue past that with a written reason, which stays on the revision.
 */
export function Submission({ ws, jobId }: { ws: Workspace; jobId: string }) {
  const { session } = useSession();
  const model = ws.model!;
  const sub = model.submission;
  const pkgId = sub.packageId;
  const editable = !!pkgId && ws.canEdit(pkgId);
  const role = session!.role;
  const canIssue = role === "manager" || role === "owner";

  const [revs, setRevs] = useState<Rev[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [newQ, setNewQ] = useState("");
  const [newA, setNewA] = useState("");

  const refresh = useCallback(async () => {
    try { setRevs(await api<Rev[]>("GET", `/jobs/${jobId}/revisions`)); setError(null); } catch (e) { setError(e instanceof ApiError && e.status === 0 ? "You are offline, so the issued revisions can't be listed." : e instanceof ApiError ? e.message : "Could not list the revisions."); }
  }, [jobId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const cmpRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (cmp) cmpRef.current?.scrollIntoView({ block: "start" }); }, [cmp]);

  const start = async () => {
    try { await api("POST", `/jobs/${jobId}/submission`, {}); await ws.load(); } catch (e) { ws.notify({ kind: "warn", text: e instanceof ApiError ? e.message : "The submission could not be started." }); }
  };

  if (!pkgId) {
    return (
      <div className="page sub-start">
        {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
        <h4>Submission</h4>
        <p className="muted">The submission is the tender letter, the qualifications and any alternatives that go with the price. Start it and the qualifications are drafted from your register (exclusions, assumptions, inclusions and open RFIs) for you to edit. When you issue, the whole tender is frozen as a revision exactly as the client receives it.</p>
        <button className="btn primary" disabled={role === "viewer"} onClick={start}>Start the submission for this job</button>
        {revs && revs.length > 0 && <Revisions revs={revs} onCompare={setCmp} jobId={jobId} model={model} />}
      </div>
    );
  }

  // ---- edits
  const problem = (text: string) => ws.notify({ kind: "warn", text });
  const editLetter = (field: string, value: unknown) => {
    let err = "";
    ws.edit(pkgId, "sub:letter", (b: Letter) => { const r = setLetterField(b, field, value); if (!r.ok) { err = r.error; return b; } return r.body; });
    if (err) problem(err);
  };
  const editQ = (id: string, field: string, value: unknown) => {
    let err = "";
    ws.edit(pkgId, `sub:q:${id}`, (b: Qualification) => { const r = setQualField(b, field, value); if (!r.ok) { err = r.error; return b; } return r.body; });
    if (err) problem(err);
  };
  const editA = (id: string, field: string, value: unknown) => {
    let err = "";
    ws.edit(pkgId, `sub:alt:${id}`, (b: Alternative) => { const r = setAltField(b, field, value); if (!r.ok) { err = r.error; return b; } return r.body; });
    if (err) problem(err);
  };
  const addQ = () => {
    const r = newQualification(newQ, sub.qualifications.map((q) => q.id), ws.nextSeq("submissionQual"));
    if (!r.ok) return problem(r.error);
    ws.adopt(pkgId, r.recordId, r.data); setNewQ("");
  };
  const addA = () => {
    const r = newAlternative(newA, sub.alternatives.map((a) => a.id), ws.nextSeq("submissionAlt"));
    if (!r.ok) return problem(r.error);
    ws.adopt(pkgId, r.recordId, r.data); setNewA("");
  };

  // ---- issuing
  const held = ws.packages.filter((p) => p.lock);
  const { blockers, warnings } = model.gates;
  const nextLabel = SUB.revisionLabel((revs?.[0]?.seq ?? 0) + 1);
  const prev = revs?.[0];
  const overriding = blockers.length > 0;
  const issueOk = canIssue && held.length === 0 && (!overriding || (role === "owner" && reason.trim().length > 0)) && !busy && revs !== null;
  const issue = () => {
    const go = async () => {
      setBusy(true);
      try {
        const r = await api<Rev>("POST", `/jobs/${jobId}/revisions`, { note, ...(overriding ? { overrideReason: reason } : {}) });
        setNote(""); setReason("");
        await refresh(); await ws.load();
        ws.notify({ kind: "info", text: `${r.label} issued and frozen. ${prev ? `${prev.label} is superseded. ` : ""}Everything in it is exactly as it stands now; later changes go in the next revision.` });
      } catch (e) { ws.notify({ kind: "warn", text: e instanceof ApiError ? e.message : "The tender could not be issued." }); }
      setBusy(false);
    };
    ws.confirm(`Issue ${nextLabel}? It is frozen exactly as the client will receive it${prev ? `, and ${prev.label} is superseded` : ""}. This can't be undone.`, `Issue ${nextLabel}`, () => void go());
  };

  const compareWith = async (rev: Rev, against: "previous" | "now") => {
    try {
      if (against === "now") {
        const a = await displayOfRevision(rev.id);
        setCmp({ title: `What has changed since ${rev.label}`, a: rev.label, b: "your work now", diff: diffEstimates(a, SUB.displayOf(model.estimate, model.inputs)) });
      } else {
        const before = revs!.find((r) => r.seq === rev.seq - 1);
        if (!before) { ws.notify({ kind: "info", text: `${rev.label} is the first revision, so there is nothing before it to compare with.` }); return; }
        const [a, b] = await Promise.all([displayOfRevision(before.id), displayOfRevision(rev.id)]);
        setCmp({ title: `What changed from ${before.label} to ${rev.label}`, a: before.label, b: rev.label, diff: diffEstimates(a, b) });
      }
    } catch (e) { ws.notify({ kind: "warn", text: e instanceof ApiError ? e.message : "The revisions could not be compared." }); }
  };

  const L = sub.letter;
  const field = (label: string, f: keyof Letter, o: { wide?: boolean; area?: boolean; width?: number } = {}) => (
    <label className={o.wide ? "wide" : ""}>
      <span>{label}</span>
      {o.area
        ? <textarea key={L?.[f]} defaultValue={L?.[f] ?? ""} rows={3} disabled={!editable} aria-label={label} onBlur={(e) => e.target.value !== (L?.[f] ?? "") && editLetter(f, e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        : <input key={L?.[f]} defaultValue={L?.[f] ?? ""} disabled={!editable} aria-label={label} style={o.width ? { width: o.width } : undefined} onBlur={(e) => e.target.value !== (L?.[f] ?? "") && editLetter(f, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />}
    </label>
  );

  return (
    <>
      <PackageBar ws={ws} pkgId={pkgId} />
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="submission">
        <div className="sub-main">
          {cmp && <div ref={cmpRef}><CompareView c={cmp} onClose={() => setCmp(null)} /></div>}
          <section>
            <h3>Tender letter</h3>
            <div className="sub-form">
              {field("To", "addressee")}{field("Attention", "attention")}
              {field("Your reference", "reference")}{field("Valid for (days)", "validityDays", { width: 70 })}
              {field("Subject", "subject", { wide: true })}
              {field("Opening", "opening", { wide: true, area: true })}
              {field("Closing", "closing", { wide: true, area: true })}
              {field("Signed by", "signatory", { wide: true })}
            </div>
          </section>
          <section>
            <h3>Qualifications <span className="sub">{sub.qualifications.filter((q) => q.include).length} of {sub.qualifications.length} in the letter</span></h3>
            <p className="muted">Drafted from the register's exclusions, assumptions, inclusions and open RFIs. Switch one off to leave it out; edit the words as they should read to the client.</p>
            <table className="plain sub-table">
              <thead><tr><th style={{ width: 54 }}>In letter</th><th style={{ width: 130 }}>From</th><th>Wording</th><th style={{ width: 70 }} /></tr></thead>
              <tbody>
                {sub.qualifications.map((q) => (
                  <tr key={q.id} className={q.include ? "" : "off"}>
                    <td className="c"><input type="checkbox" checked={q.include} disabled={!editable} onChange={(e) => editQ(q.id, "include", e.target.checked)} aria-label={`Include ${q.ref || q.id}`} /></td>
                    <td className="muted">{q.kind === "custom" ? "Added here" : `${q.kind} ${q.ref}`}</td>
                    <td><textarea key={q.text} defaultValue={q.text} rows={2} disabled={!editable} aria-label={`Wording of ${q.ref || q.id}`} onBlur={(e) => e.target.value !== q.text && editQ(q.id, "text", e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></td>
                    <td><button className="btn" disabled={!editable} onClick={() => ws.removeRow(pkgId, `sub:q:${q.id}`)}>Delete</button></td>
                  </tr>
                ))}
                <tr className="new">
                  <td /><td className="muted">New</td>
                  <td><input value={newQ} disabled={!editable} placeholder="Write a qualification and press Enter" aria-label="New qualification" onChange={(e) => setNewQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addQ(); }} /></td>
                  <td><button className="btn" disabled={!editable || !newQ.trim()} onClick={addQ}>Add</button></td>
                </tr>
              </tbody>
            </table>
          </section>
          <section>
            <h3>Alternatives <span className="sub">{sub.alternatives.filter((a) => a.include).length} of {sub.alternatives.length} in the letter</span></h3>
            <table className="plain sub-table">
              <thead><tr><th style={{ width: 54 }}>In letter</th><th style={{ width: 240 }}>Alternative</th><th>What it is</th><th style={{ width: 110 }}>Price change $</th><th style={{ width: 70 }} /></tr></thead>
              <tbody>
                {sub.alternatives.map((a) => (
                  <tr key={a.id} className={a.include ? "" : "off"}>
                    <td className="c"><input type="checkbox" checked={a.include} disabled={!editable} onChange={(e) => editA(a.id, "include", e.target.checked)} aria-label={`Include ${a.title}`} /></td>
                    <td><input key={a.title} defaultValue={a.title} disabled={!editable} aria-label="Alternative title" onBlur={(e) => e.target.value !== a.title && editA(a.id, "title", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></td>
                    <td><textarea key={a.description} defaultValue={a.description} rows={2} disabled={!editable} aria-label="What the alternative is" onBlur={(e) => e.target.value !== a.description && editA(a.id, "description", e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></td>
                    <td><input key={a.amount} defaultValue={a.amount ? money(a.amount) : ""} disabled={!editable} aria-label="Price change" style={{ textAlign: "right" }} onBlur={(e) => e.target.value !== (a.amount ? money(a.amount) : "") && editA(a.id, "amount", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></td>
                    <td><button className="btn" disabled={!editable} onClick={() => ws.removeRow(pkgId, `sub:alt:${a.id}`)}>Delete</button></td>
                  </tr>
                ))}
                <tr className="new">
                  <td /><td colSpan={3}><input value={newA} disabled={!editable} placeholder="Name an alternative and press Enter" aria-label="New alternative" onChange={(e) => setNewA(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addA(); }} /></td>
                  <td><button className="btn" disabled={!editable || !newA.trim()} onClick={addA}>Add</button></td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>

        <aside className="sub-side" aria-label="Issuing">
          <h3>Ready to issue? <span className="sub">{blockers.length === 0 ? "nothing in the way" : `${blockers.length} thing${blockers.length === 1 ? "" : "s"} in the way`}</span></h3>
          <div className="sub-pad">
            {blockers.length === 0 && warnings.length === 0 && <p className="muted">Scope is backed up, every row has its rate, and the client schedule adds up to the all-in tender.</p>}
            {blockers.map((g) => <Gate key={g.id} g={g} jobId={jobId} blocking />)}
            {warnings.map((g) => <Gate key={g.id} g={g} jobId={jobId} />)}
            {held.length > 0 && <div className="gate block"><span className="tag">Checked out</span> <span>{held.map((p) => `${p.name}${p.lock!.holder === session!.userId ? " (you)" : ` (${p.lock!.holder_name})`}`).join(", ")} must be checked in first: a revision is what is stored, not what is in someone's drafts.</span></div>}
            {ws.totalChanges > 0 && <div className="gate"><span className="tag">Unsaved</span> <span>You have {ws.totalChanges} change{ws.totalChanges === 1 ? "" : "s"} not checked in. They won't be in the revision.</span></div>}
          </div>

          <h3>Issue {nextLabel}</h3>
          <div className="sub-pad">
            {!canIssue && <p className="muted">Issuing needs the manager role.</p>}
            <label className="sub-field"><span>Note (what this revision is)</span>
              <input value={note} onChange={(e) => setNote(e.target.value)} disabled={!canIssue} placeholder="After addendum 2" aria-label="Revision note" />
            </label>
            {overriding && (
              <label className="sub-field"><span>{role === "owner" ? "Reason for issuing with things in the way (kept on the revision)" : "Only an owner can issue with things in the way"}</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={role !== "owner"} placeholder="Why this tender goes out as it is" aria-label="Reason for overriding" />
              </label>
            )}
            <button className="btn primary" disabled={!issueOk} onClick={issue} title={issueOk ? "" : held.length ? "Check everything in first" : overriding ? "Clear what is in the way first" : ""}>
              {overriding ? `Issue ${nextLabel} anyway` : `Issue ${nextLabel}`}
            </button>
          </div>

          <h3>Issued revisions <span className="sub">{revs ? `${revs.length}` : ""}</span></h3>
          <div className="sub-pad">
            {error && <p className="muted">{error}</p>}
            {revs && revs.length === 0 && <p className="muted">Nothing issued yet. {nextLabel} will be the first.</p>}
            {revs && revs.length > 0 && <Revisions revs={revs} onCompare={(c) => setCmp(c)} jobId={jobId} model={model} compareWith={compareWith} />}
          </div>
        </aside>
      </div>
    </>
  );
}

function Gate({ g, jobId, blocking }: { g: SUB.Gate; jobId: string; blocking?: boolean }) {
  const w = WHERE[g.where]!;
  return (
    <div className={`gate${blocking ? " block" : ""}`}>
      <span className="tag">{blocking ? "In the way" : "Look at"}</span> <span>{g.text}</span> <a href={hrefJob(jobId, w.view)}>{w.label}</a>
    </div>
  );
}

function Revisions({ revs, compareWith }: { revs: Rev[]; onCompare: (c: Comparison | null) => void; jobId: string; model: unknown; compareWith?: (r: Rev, against: "previous" | "now") => void }) {
  return (
    <div className="revs">
      {revs.map((r) => (
        <div key={r.id} className={`rev${r.supersededByLabel ? " old" : ""}`}>
          <div className="rev-head">
            <strong>{r.label}</strong>
            {r.supersededByLabel ? <span className="badge grey">Superseded by {r.supersededByLabel}</span> : <span className="badge solid">Current</span>}
            {r.verified ? <span className="badge" title="The stored records still match what they were when it was issued">Unchanged</span> : <span className="badge solid" title="The stored records no longer match what was issued. Tell a manager.">ALTERED</span>}
            {r.overrides.length > 0 && <span className="badge dashed" title={r.overrides[0]!.reason}>Issued past a blocker</span>}
          </div>
          <div className="muted">{when(r.issuedAt)} by {r.issuedBy}</div>
          {r.note && <div>{r.note}</div>}
          <div className="num">All-in <strong>${money(r.totals.allIn)}</strong> excl. GST · gross margin {pct(r.totals.grossMarginOnSell)}</div>
          {r.overrides.length > 0 && <div className="muted">Reason given: {r.overrides[0]!.reason}</div>}
          {compareWith && (
            <div className="rev-actions">
              <button className="btn" onClick={() => compareWith(r, "previous")} disabled={r.seq === 1}>What changed from the one before</button>
              <button className="btn" onClick={() => compareWith(r, "now")}>Compare with my work now</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CompareView({ c, onClose }: { c: Comparison; onClose: () => void }) {
  const d = c.diff;
  const sign = (n: number) => `${n > 0 ? "+" : ""}${money(n)}`;
  const more = (n: number, shown: number) => (n > shown ? <tr><td colSpan={5} className="muted">and {n - shown} more</td></tr> : null);
  return (
    <section className="compare">
      <h3>{c.title} <button className="btn" style={{ marginLeft: "auto" }} onClick={onClose}>Close</button></h3>
      {d.identical && <p className="muted">Nothing has changed between {c.a} and {c.b}.</p>}
      <table className="plain">
        <thead><tr><th>Figure</th><th className="r">{c.a}</th><th className="r">{c.b}</th><th className="r">Change</th></tr></thead>
        <tbody>{d.headline.map((h) => <tr key={h.key}><td>{h.label}</td><td className="r num">{money(h.a)}</td><td className="r num">{money(h.b)}</td><td className={`r num${h.delta ? " chg" : ""}`}>{h.delta ? sign(h.delta) : ""}</td></tr>)}</tbody>
      </table>
      {d.settings.length > 0 && <><h4>Commercial settings</h4><table className="plain"><tbody>{d.settings.map((s) => <tr key={s.key}><td>{s.label}</td><td className="r num">{pct(s.a)}</td><td className="r num">{pct(s.b)}</td></tr>)}</tbody></table></>}
      {d.overlays.length > 0 && <><h4>Subcontract packages</h4><table className="plain"><tbody>{d.overlays.map((o) => <tr key={o.name}><td>{o.name}</td><td className="r num">{money(o.a)}</td><td className="r num">{money(o.b)}</td><td className="r num chg">{sign(o.delta)}</td></tr>)}</tbody></table></>}
      {d.commercial.length > 0 && <><h4>Commercial lines</h4><table className="plain"><tbody>{d.commercial.map((x) => <tr key={x.ref}><td>{x.ref} {x.name}</td><td className="r">{x.include_a === null ? "new" : x.include_a ? "in" : "out"} → {x.include_b ? "in" : "out"}</td><td className="r num">{money(x.amount_a)}</td><td className="r num">{money(x.amount_b)}</td><td className="r num chg">{sign(x.delta)}</td></tr>)}</tbody></table></>}
      {d.sections.some((s) => s.delta) && <><h4>Sections</h4><table className="plain"><tbody>{d.sections.filter((s) => s.delta).map((s) => <tr key={s.section}><td>{s.section}</td><td className="r num">{money(s.a)}</td><td className="r num">{money(s.b)}</td><td className="r num chg">{sign(s.delta)}</td></tr>)}</tbody></table></>}
      {d.qs.length > 0 && <><h4>Quantities and items ({d.qs.length})</h4><table className="plain"><tbody>{d.qs.slice(0, 12).map((q) => <tr key={q.code}><td>{q.code} {q.description}</td><td className="muted">{q.kind}</td><td className="r num">{q.qty_a ?? ""} → {q.qty_b ?? ""} {q.unit}</td><td className="r num">{money(q.amount_b)}</td><td className="r num chg">{sign(q.delta)}</td></tr>)}{more(d.qs.length, 12)}</tbody></table></>}
      {d.buildup.length > 0 && <><h4>Build-up rows ({d.buildup.length})</h4><table className="plain"><tbody>{d.buildup.slice(0, 12).map((r) => <tr key={r.row_id}><td>{r.row_id} {r.task}</td><td className="muted">{r.kind}</td><td className="r num">{r.resource}</td><td className="r num">{money(r.cost_b)}</td><td className="r num chg">{sign(r.delta)}</td></tr>)}{more(d.buildup.length, 12)}</tbody></table></>}
    </section>
  );
}
