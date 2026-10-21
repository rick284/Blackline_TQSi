import { useMemo, useState } from "react";
import { EVIDENCE, buildRecords, canBuild, formFromBuild, newForm, preview, type LabourBuild, type LabourForm } from "../lib/labour.js";
import type { Model } from "../lib/model.js";
import type { Workspace } from "../workspace.js";

const today = () => new Date().toLocaleDateString("en-CA");
const money = (x: { toFixed: (n: number) => string }, dp = 2) => x.toFixed(dp).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const statusClass = { GREEN: "badge solid", AMBER: "badge grey", RED: "badge red" } as const;

/**
 * The labour true-cost builder, in the page under the rate grid. Fill in what the employer actually pays and the build-up works out the
 * true cost per productive hour as you type, step by step, with the evidence status the policy gives it. Saving writes the library rate and
 * the build behind it into your draft; the rate then reprices every row that uses it, like any other rate edit.
 */
export function LabourBuilder({ ws, model, pkgId, code, onClose }: { ws: Workspace; model: Model; pkgId: string; code: string | null; onClose: () => void }) {
  const editable = ws.canEdit(pkgId);
  const existing = code ? (model.labourBuilds[code] as LabourBuild | undefined) : undefined;
  const [form, setForm] = useState<LabourForm>(() => (code && existing ? formFromBuild(code, existing.inputs) : newForm(today(), code ?? "")));
  const [problem, setProblem] = useState<string | null>(null);
  const isNewCode = !existing;
  const set = (k: keyof LabourForm, v: string | boolean) => { setProblem(null); setForm((f) => ({ ...f, [k]: v })); };
  const p = useMemo(() => preview(form), [form]);
  const priorRate = existing && code ? model.library.find((r) => r.code === code)?.baseRate : undefined;

  const text = (k: keyof LabourForm, label: string, o: { wide?: boolean; hint?: string; type?: string; readOnly?: boolean } = {}) => (
    <label className={o.wide ? "wide" : ""}>
      <span>{label}</span>
      <input value={String(form[k])} disabled={!editable || o.readOnly} inputMode={o.type === "num" ? "decimal" : undefined} onChange={(e) => set(k, e.target.value)} placeholder={o.hint} aria-label={label} />
    </label>
  );

  const save = () => {
    const code = form.code.trim();
    const ok = canBuild(code, model.library.some((r) => r.code === code), !!model.labourBuilds[code]);
    if (!ok.ok) return setProblem(ok.why);
    if (!p.ok) return setProblem(p.error);
    const prevLib = ws.record(`library:${code}`);
    const prevBuild = model.labourBuilds[code] as LabourBuild | undefined;
    const made = buildRecords(code, form, { library: prevLib, build: prevBuild }, ws.nextSeq("library"));
    ws.saveLabour(pkgId, code, made.library, { ...made.build, seq: ws.record(`labour:${code}`)?.seq ?? ws.nextSeq("labourBuild") });
    ws.notify({ kind: "info", text: `${code} is ${money(p.result.rateRounded)} per hour. It is in your draft; check the Rate Library in to share it.` });
    onClose();
  };

  return (
    <div className="pane builder" style={{ flex: "5 1 0" }}>
      <h3>
        Labour build-up <span className="sub">{isNewCode ? "a new labour rate" : form.code}</span>
        <span style={{ marginLeft: "auto" }}>
          {editable && <button className="btn primary" onClick={save} disabled={!p.ok}>{isNewCode ? "Add to library" : "Update rate"}</button>}{" "}
          <button className="btn" onClick={onClose}>{editable ? "Cancel" : "Close"}</button>
        </span>
      </h3>
      {problem && <div className="notice warn" role="alert">{problem}</div>}
      <div className="builder-body">
        <div className="fields">
          <h5>Who this rate is for</h5>
          {text("code", "Library code", { hint: "LAB-CARP", readOnly: !isNewCode })}
          {text("role", "Role", { hint: "Carpenter" })}
          {text("employment_basis", "Employment basis", { hint: "Permanent employee" })}
          {text("jurisdiction", "Jurisdiction")}
          <h5>Pay</h5>
          {text("hourly_rate", "Gross hourly rate ($)", { type: "num" })}
          {text("paid_hours_week", "Paid hours per week", { type: "num" })}
          {text("productive_hours_week", "Productive hours per week", { type: "num", hint: "paid hours less breaks, travel, toolbox talks" })}
          {text("days_per_week", "Days per week", { type: "num" })}
          <h5>On-costs</h5>
          {text("kiwisaver_pct", "Employer KiwiSaver (%)", { type: "num" })}
          {text("levy_pct", "Insurance and ACC levies (%)", { type: "num", hint: "from your levy invoices" })}
          {text("annual_leave_days", "Annual leave (days a year)", { type: "num" })}
          {text("stat_days", "Public holidays (days)", { type: "num" })}
          {text("sick_days", "Sick leave (days)", { type: "num" })}
          {text("other_paid_days", "Other paid days off", { type: "num" })}
          {text("redundancy_pct", "Redundancy provision (%)", { type: "num" })}
          {text("weekly_allowance", "Weekly allowances ($)", { type: "num", hint: "tools, clothing, phone" })}
          {text("supervision_pct", "Supervision loading (%)", { type: "num" })}
          <h5>Evidence</h5>
          <label>
            <span>What the rate rests on</span>
            <select value={form.evidence} disabled={!editable} onChange={(e) => set("evidence", e.target.value)} aria-label="Evidence">
              {EVIDENCE.map((x) => <option key={x}>{x}</option>)}
            </select>
          </label>
          {text("source_date", "Source dated")}
          {text("source_note", "Where it came from", { wide: true, hint: "payroll run, contractor survey, award rate…" })}
          {text("reviewer", "Reviewed by")}
          <label className="check">
            <input type="checkbox" checked={form.independent_check} disabled={!editable} onChange={(e) => set("independent_check", e.target.checked)} />
            <span>Checked by someone independent</span>
          </label>
          <p className="muted wide">Statutory minimums are filled in as suggestions: change them to match what you actually pay. PAYE is never added, because it comes out of the worker's pay. Overhead, profit and fleet are priced elsewhere.</p>
        </div>

        <div className="steps" aria-live="polite">
          {p.ok ? (
            <>
              <div className="result">
                <span className="big mono">${money(p.result.rateRounded)}</span> per productive hour
                <span className={statusClass[p.result.status]} style={{ marginLeft: 10 }}>{p.result.status}</span>
              </div>
              <p className="muted">{p.result.statusNote}</p>
              {priorRate !== undefined && <p className="muted">In the library now: ${Number(priorRate).toFixed(2)}</p>}
              <table>
                <thead><tr><th>Step</th><th className="r">Amount</th><th className="r">Running</th></tr></thead>
                <tbody>
                  {p.result.steps.map((s) => (
                    <tr key={s.label}>
                      <td>{s.label}<div className="muted">{s.basis}</div></td>
                      <td className="r mono">{money(s.amount)}</td>
                      <td className="r mono">{money(s.running)}</td>
                    </tr>
                  ))}
                  <tr className="total"><td>Weekly true cost</td><td /><td className="r mono">{money(p.result.weeklyCost)}</td></tr>
                  <tr><td>Divided by productive hours</td><td /><td className="r mono">{form.productive_hours_week}</td></tr>
                  <tr className="total"><td>Per productive hour</td><td /><td className="r mono">{money(p.result.rate, 4)}</td></tr>
                </tbody>
              </table>
              <p className="muted">
                {money(p.result.perPaidHour)} per paid hour. Leave loading {p.result.leavePct.times(100).toFixed(2)}%. Productive share of paid time {p.result.productivity.times(100).toFixed(1)}%.
              </p>
            </>
          ) : (
            <p className="muted">{p.error}</p>
          )}
          {existing?.history && existing.history.length > 0 && (
            <>
              <h5>Earlier builds of this rate</h5>
              <table>
                <tbody>
                  {[...existing.history].reverse().map((h, i) => (
                    <tr key={i}><td>{h.source_date}</td><td>{h.evidence}</td><td>{h.status}</td><td className="r mono">${h.rate}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
