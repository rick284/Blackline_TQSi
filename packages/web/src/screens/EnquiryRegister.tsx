import { useState } from "react";
import { api, ApiError } from "../api.js";
import { arrange, dueDate, dueText, type EnquiryJob, FILTERS, type Filter, isOpen, KIND_LABEL, pipeline, STAGE_LABEL, whyNotGo } from "../lib/enquiries.js";
import { money } from "../lib/fmt.js";
import { hrefJob } from "../route.js";
import type { Env } from "./ContactsPage.js";

type Patch = { contactId?: string | null; ownerId?: string | null; dueAt?: string | null; notes?: string; approxValue?: string };
type Ask = { job: EnquiryJob; decision: "go" | "no-bid" | "lost" | "reopen" };

const say = (e: unknown, f: string) => (e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : f);

/** What a patch would be to put a job's fields back as they are now. */
function before(j: EnquiryJob, p: Patch): Patch {
  const b: Patch = {};
  if ("contactId" in p) b.contactId = j.contact_id;
  if ("ownerId" in p) b.ownerId = j.owner_id;
  if ("dueAt" in p) b.dueAt = j.due_at ? dueDate(j.due_at) : null;
  if ("notes" in p) b.notes = j.notes;
  if ("approxValue" in p) b.approxValue = j.approx_value;
  return b;
}

const LABELS: Record<Ask["decision"], { text: (j: EnquiryJob) => string; button: string; reason?: string }> = {
  go: { text: (j) => `Go on ${j.name}? It becomes a tender owned by ${j.owner_name ?? "?"}, due ${dueDate(j.due_at)}.`, button: "Go" },
  "no-bid": { text: (j) => `Why are you not bidding on ${j.name}? The reason is kept so you can see which work you walk away from.`, button: "Log no bid", reason: "Reason" },
  lost: { text: (j) => `Why was ${j.name} lost? The reason is kept.`, button: "Mark lost", reason: "Reason" },
  reopen: { text: (j) => `Reopen ${j.name} as an enquiry?`, button: "Reopen" },
};

export function EnquiryRegister({ env }: { env: Env }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [ask, setAsk] = useState<Ask | null>(null);
  const [reason, setReason] = useState("");
  const [form, setForm] = useState({ name: "", contactId: "", dueAt: "" });
  const now = new Date();
  const counts = pipeline(env.jobs);
  const rows = arrange(env.jobs, filter);

  async function edit(j: EnquiryJob, patch: Patch, label: string) {
    const back = before(j, patch);
    try {
      await api("POST", `/jobs/${j.id}/enquiry`, patch);
      env.push({ label: `${label} on ${j.name}`, undo: async () => { await api("POST", `/jobs/${j.id}/enquiry`, back); }, redo: async () => { await api("POST", `/jobs/${j.id}/enquiry`, patch); } });
    } catch (e) { env.notify("warn", say(e, "That could not be saved.")); }
    await env.reload();
  }

  async function add() {
    if (!form.name.trim()) return env.notify("warn", "Name the job first.");
    try {
      await api("POST", "/jobs", { name: form.name.trim(), ...(form.contactId ? { contactId: form.contactId } : {}), ...(form.dueAt ? { dueAt: form.dueAt } : {}) });
      setForm({ name: "", contactId: "", dueAt: "" });
      env.notify("info", "Enquiry registered. It can't be deleted; if you won't bid, log a no bid with the reason.");
    } catch (e) { env.notify("warn", say(e, "The enquiry could not be added.")); }
    await env.reload();
  }

  async function decide() {
    if (!ask) return;
    try {
      await api("POST", `/jobs/${ask.job.id}/decision`, { decision: ask.decision, reason });
      env.notify("info", ask.decision === "go" ? `${ask.job.name} is now a tender.` : ask.decision === "reopen" ? `${ask.job.name} is an enquiry again.` : `${ask.job.name}: ${STAGE_LABEL[ask.decision === "lost" ? "lost" : "no-bid"]}, with the reason kept.`);
      setAsk(null); setReason("");
    } catch (e) { env.notify("warn", say(e, "That decision could not be saved.")); }
    await env.reload();
  }

  const start = (job: EnquiryJob, decision: Ask["decision"]) => { setAsk({ job, decision }); setReason(""); };
  const blur = (e: { currentTarget: HTMLInputElement }) => e.currentTarget.blur();
  const ro = !env.canEdit;

  return (
    <div className="register">
      <div className="pipeline" aria-label="Pipeline">
        {FILTERS.map((f) => {
          const n = f.key === "all" ? env.jobs.length : env.jobs.filter((j) => f.match(j.status)).length;
          return <button key={f.key} className={`chip${filter === f.key ? " on" : ""}`} onClick={() => setFilter(f.key)}>{f.label} <small>{n}</small></button>;
        })}
        <span className="muted" style={{ marginLeft: "auto" }}>{counts.enquiry} enquir{counts.enquiry === 1 ? "y" : "ies"}, {counts.tender} being tendered, {counts.issued} issued</span>
      </div>

      {ask && (
        <div className="notice wrap ask" role="alert" aria-label="Decision">
          <span>{LABELS[ask.decision].text(ask.job)}</span>
          {LABELS[ask.decision].reason && <input autoFocus value={reason} placeholder={LABELS[ask.decision].reason} aria-label="Reason" onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void decide(); }} style={{ flex: 1, minWidth: 220 }} />}
          <button className="btn primary" style={{ marginLeft: 0, textDecoration: "none" }} onClick={() => void decide()}>{LABELS[ask.decision].button}</button>
          <button className="btn" style={{ marginLeft: 0, textDecoration: "none" }} onClick={() => setAsk(null)}>Cancel</button>
        </div>
      )}

      <div className="tablewrap">
        <table className="plain reg">
          <thead>
            <tr><th style={{ width: 210 }}>Job</th><th style={{ width: 170 }}>Client</th><th style={{ width: 130 }}>Owner</th><th style={{ width: 128 }}>Due</th><th style={{ width: 96 }}>Deadline</th>
              <th className="r" style={{ width: 110 }}>Approx. value $</th><th style={{ width: 120 }}>Stage</th><th>Note</th><th style={{ width: 150 }} /></tr>
          </thead>
          <tbody>
            {env.canEdit && (
              <tr className="new">
                <td><input value={form.name} placeholder="New enquiry: job name" aria-label="New enquiry job name" onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /></td>
                <td>
                  <select value={form.contactId} aria-label="New enquiry client" onChange={(e) => setForm({ ...form, contactId: e.target.value })}>
                    <option value="">Client…</option>
                    {env.active.map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === "client" ? "" : ` (${KIND_LABEL[c.kind]})`}</option>)}
                  </select>
                </td>
                <td />
                <td><input type="date" value={form.dueAt} aria-label="New enquiry due date" onChange={(e) => setForm({ ...form, dueAt: e.target.value })} /></td>
                <td colSpan={4} className="muted">Owner, value and notes are set on the line once it is added.</td>
                <td><button className="btn" disabled={!form.name.trim()} onClick={() => void add()}>Add enquiry</button></td>
              </tr>
            )}
            {rows.map((j) => {
              const open = isOpen(j.status);
              const wait = whyNotGo(j);
              const days = open ? dueText(j.due_at, now) : "";
              return (
                <tr key={j.id} className={open ? "" : "closed"}>
                  <td><a href={hrefJob(j.id)}>{j.name}</a></td>
                  <td>
                    <select value={j.contact_id ?? ""} disabled={ro} aria-label={`Client for ${j.name}`} onChange={(e) => void edit(j, { contactId: e.target.value || null }, "Client")}>
                      <option value="">{j.client && !j.contact_id ? `${j.client} (not in contacts)` : "None"}</option>
                      {env.contacts.filter((c) => !c.archived_at || c.id === j.contact_id).map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === "client" ? "" : ` (${KIND_LABEL[c.kind]})`}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={j.owner_id ?? ""} disabled={ro} aria-label={`Owner of ${j.name}`} onChange={(e) => void edit(j, { ownerId: e.target.value || null }, "Owner")}>
                      <option value="">Not set</option>
                      {env.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
                    </select>
                  </td>
                  <td><input type="date" key={j.due_at ?? "none"} defaultValue={dueDate(j.due_at)} disabled={ro} aria-label={`Due date of ${j.name}`} onBlur={(e) => e.target.value !== dueDate(j.due_at) && void edit(j, { dueAt: e.target.value || null }, "Due date")} /></td>
                  <td className={days.includes("overdue") ? "overdue" : "muted"}>{days}</td>
                  <td><input key={j.approx_value} defaultValue={j.approx_value ? money(j.approx_value) : ""} disabled={ro} aria-label={`Approximate value of ${j.name}`} style={{ textAlign: "right" }} onBlur={(e) => e.target.value !== (j.approx_value ? money(j.approx_value) : "") && void edit(j, { approxValue: e.target.value }, "Value")} onKeyDown={(e) => { if (e.key === "Enter") blur(e); }} /></td>
                  <td><span className={`badge ${j.status === "tender" ? "solid" : j.status === "no-bid" || j.status === "lost" ? "dashed" : j.status === "issued" ? "" : "grey"}`}>{STAGE_LABEL[j.status] ?? j.status}</span>
                    {j.decision_reason && <div className="muted why" title={j.decision_reason}>{j.decision_reason}</div>}</td>
                  <td><input key={j.notes} defaultValue={j.notes} disabled={ro} aria-label={`Note for ${j.name}`} onBlur={(e) => e.target.value !== j.notes && void edit(j, { notes: e.target.value }, "Note")} onKeyDown={(e) => { if (e.key === "Enter") blur(e); }} /></td>
                  <td className="acts">
                    {env.canDecide && j.status === "enquiry" && <button className="btn primary" disabled={!!wait} title={wait ?? "Take this to tender"} onClick={() => start(j, "go")}>Go</button>}
                    {env.canDecide && (j.status === "enquiry" || j.status === "tender") && <button className="btn" onClick={() => start(j, "no-bid")}>No bid</button>}
                    {env.canDecide && j.status === "issued" && <button className="btn" onClick={() => start(j, "lost")}>Lost</button>}
                    {env.canDecide && (j.status === "no-bid" || j.status === "lost") && <button className="btn" onClick={() => start(j, "reopen")}>Reopen</button>}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={9} className="muted">Nothing here. {filter === "open" ? "Add an enquiry above." : "Try another filter."}</td></tr>}
          </tbody>
        </table>
      </div>
      {!env.canDecide && <p className="muted pad">Go and no-go decisions are made by a manager.</p>}
    </div>
  );
}
