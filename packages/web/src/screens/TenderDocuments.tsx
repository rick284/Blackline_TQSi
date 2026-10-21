import { Fragment, useState } from "react";
import { documents as DOC } from "@blackline/tender/core";
import { api, ApiError } from "../api.js";
import { clearFlags, groupFlags, newDocument, newRevision, type DocFlag } from "../lib/documents.js";
import { hrefJob, type View } from "../route.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";
import { PackageBar } from "./PackageBar.js";

const WHERE: Record<DocFlag["kind"], { view: View; label: string }> = {
  scope: { view: "scope", label: "Scope Register" }, cost: { view: "estimate", label: "Estimate" }, quote: { view: "scope", label: "Quotes" }, unlinked: { view: "scope", label: "Scope Register" },
};
const when = (iso: string) => new Date(iso).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });

/**
 * Tender Documents: the drawings, specifications, client BOQ and reports the tender is priced from, with every revision. A new revision of a
 * document raises a flag for each scope item, estimate line and quote that depends on it, and the tender can't be issued until someone has
 * checked each one and said so. The platform finds what to look at; a person decides it is fine.
 */
export function TenderDocuments({ ws, jobId }: { ws: Workspace; jobId: string }) {
  const { session } = useSession();
  const model = ws.model!;
  const pkgId = model.documentsPackageId;
  const editable = !!pkgId && ws.canEdit(pkgId);
  const res = model.estimate.documents;

  const [revFor, setRevFor] = useState<string | null>(null);
  const [showRevs, setShowRevs] = useState<string | null>(null);
  const [rf, setRf] = useState({ rev: "", date: "", addendum: "", note: "" });
  const [nd, setNd] = useState({ title: "", category: "drawing", rev: "" });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [showCleared, setShowCleared] = useState(false);

  const start = async () => {
    try { await api("POST", `/jobs/${jobId}/documents`, {}); await ws.load(); } catch (e) { ws.notify({ kind: "warn", text: e instanceof ApiError ? e.message : "The document register could not be started." }); }
  };

  if (!pkgId) {
    return (
      <div className="page sub-start">
        {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
        <h4>Tender Documents</h4>
        <p className="muted">The drawings, specifications, client BOQ and reports this tender is priced from, each with its revisions. Start it and the documents already in the register become the first revision of each. After that, every new revision or addendum flags the scope items, estimate lines and quotes that depend on it, and the tender can't be issued until each one has been checked.</p>
        <button className="btn primary" disabled={session!.role === "viewer"} onClick={start}>Start the document register for this job</button>
      </div>
    );
  }

  const say = (text: string) => ws.notify({ kind: "warn", text });
  const editDoc = (id: string, field: string, value: unknown) => {
    let err = "";
    ws.edit(pkgId, `doc:${id}`, (b: DOC.TenderDoc) => { try { return DOC.setDocField(b, field, value); } catch (e) { err = e instanceof DOC.DocumentError ? e.message : "Not saved."; return b; } });
    if (err) say(err);
  };
  const allDocs = res.documents.map(({ revisions: _r, current: _c, openFlags: _o, ...d }) => d as DOC.TenderDoc);
  const allRevs = res.documents.flatMap((d) => d.revisions);

  const addDoc = () => {
    const r = newDocument(nd, allDocs, allRevs, { doc: ws.nextSeq("tenderDoc"), rev: ws.nextSeq("tenderDocRev") });
    if (!r.ok) return say(r.error);
    ws.batch(pkgId, r.items); setNd({ title: "", category: nd.category, rev: "" });
  };
  const addRev = (docId: string) => {
    const r = newRevision(docId, rf, allRevs, ws.nextSeq("tenderDocRev"));
    if (!r.ok) return say(r.error);
    ws.batch(pkgId, r.items); setRf({ rev: "", date: "", addendum: "", note: "" }); setRevFor(null);
    ws.notify({ kind: "info", text: "Revision recorded. Anything that depends on this document is now flagged below, and the tender can't be issued until each is checked." });
  };
  const removeDoc = (d: (typeof res.documents)[number]) => {
    const items = [{ recordId: `doc:${d.id}`, data: null }, ...d.revisions.map((r) => ({ recordId: `docrev:${r.id}`, data: null })),
      ...res.flags.filter((f) => f.docId === d.id && f.clear).map((f) => ({ recordId: `docclear:${f.key}`, data: null }))];
    ws.confirm(`Delete ${d.ref} ${d.title} with its ${d.revisions.length} revision${d.revisions.length === 1 ? "" : "s"}? Undo brings it back until you check in.`, "Delete document", () => ws.batch(pkgId, items));
  };
  const removeRev = (d: (typeof res.documents)[number], r: DOC.DocRevision) => {
    const items = [{ recordId: `docrev:${r.id}`, data: null }, ...res.flags.filter((f) => f.revId === r.id && f.clear).map((f) => ({ recordId: `docclear:${f.key}`, data: null }))];
    ws.confirm(`Delete ${r.rev} of ${d.ref}? Its flags go with it and ${d.revisions[d.revisions.length - 2]?.rev ?? "the earlier revision"} becomes current again.`, "Delete revision", () => ws.batch(pkgId, items));
  };
  const clear = (flags: DocFlag[], noteKey: string) => {
    const r = clearFlags(flags, notes[noteKey] ?? "", session!.name, new Date());
    if (!r.ok) return say(r.error);
    ws.batch(pkgId, r.items); setNotes((n) => ({ ...n, [noteKey]: "" }));
  };

  const groups = groupFlags(res.flags);
  const openGroups = groups.filter((g) => g.open > 0);
  const stillOpen = new Set(openGroups.map((g) => g.revId));
  const clearedFlags = res.flags.filter((f) => !f.open && !stillOpen.has(f.revId)); // a revision with some left open shows its checked ones in its own group
  const blur = (e: { currentTarget: HTMLInputElement }) => e.currentTarget.blur();

  return (
    <>
      <PackageBar ws={ws} pkgId={pkgId} />
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="docs">
        <div className="pipeline">
          <span><strong>{res.documents.length}</strong> document{res.documents.length === 1 ? "" : "s"}</span>
          <span className={res.open ? "overdue" : "muted"}>{res.open ? `${res.open} change${res.open === 1 ? "" : "s"} to check` : "Every change has been checked"}</span>
          <span className="muted">RFIs and clarifications are kept in the register: {model.estimate.registerSummary.openRfis} open. <a href={hrefJob(jobId, "scope")}>Scope Register</a></span>
        </div>

        {openGroups.length > 0 && (
          <section>
            <h3>Changes to check <span className="sub">the tender can't be issued until each has been looked at</span></h3>
            <div className="sub-pad">
              {openGroups.map((g) => {
                const open = g.flags.filter((f) => f.open);
                return (
                  <div key={g.revId} className="flaggroup">
                    <div className="flagtitle">
                      <strong>{g.docRef} {g.docTitle}</strong> · {g.rev}{g.addendum ? ` · ${g.addendum}` : ""}{g.revNote ? <span className="muted"> · {g.revNote}</span> : null}
                    </div>
                    {g.flags.map((f) => (
                      <div key={f.key} className={`flagrow${f.open ? "" : " done"}`}>
                        <span>{f.label} <a href={hrefJob(jobId, WHERE[f.kind].view)}>{WHERE[f.kind].label}</a></span>
                        {f.open ? (
                          editable && <><input value={notes[f.key] ?? ""} placeholder="What you checked" aria-label={`Note for ${f.label}`} onChange={(e) => setNotes({ ...notes, [f.key]: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") clear([f], f.key); }} />
                            <button className="btn" onClick={() => clear([f], f.key)}>Checked</button></>
                        ) : <span className="muted">Checked by {f.clear!.by}: {f.clear!.note}</span>}
                      </div>
                    ))}
                    {editable && open.length > 1 && (
                      <div className="flagrow all">
                        <span className="muted">All {open.length} for this revision</span>
                        <input value={notes[g.revId] ?? ""} placeholder="What you checked" aria-label={`Note for all of ${g.docRef} ${g.rev}`} onChange={(e) => setNotes({ ...notes, [g.revId]: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") clear(open, g.revId); }} />
                        <button className="btn primary" onClick={() => clear(open, g.revId)}>All checked</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <section>
          <h3>Documents <span className="sub">{res.gate}</span></h3>
          <div className="tablewrap">
            <table className="plain reg">
              <thead>
                <tr><th style={{ width: 80 }}>Ref</th><th style={{ width: 270 }}>Document</th><th style={{ width: 130 }}>Kind</th><th style={{ width: 130 }}>Current revision</th><th style={{ width: 100 }}>Dated</th>
                  <th style={{ width: 130 }}>Addendum</th><th className="r" style={{ width: 60 }}>Issues</th><th className="r" style={{ width: 80 }}>To check</th><th style={{ width: 250 }} /></tr>
              </thead>
              <tbody>
                {editable && (
                  <tr className="new">
                    <td className="muted">New</td>
                    <td><input value={nd.title} placeholder="New document: title" aria-label="New document title" onChange={(e) => setNd({ ...nd, title: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addDoc(); }} /></td>
                    <td><select value={nd.category} aria-label="New document kind" onChange={(e) => setNd({ ...nd, category: e.target.value })}>{DOC.CATEGORIES.map((c) => <option key={c} value={c}>{DOC.CATEGORY_LABEL[c]}</option>)}</select></td>
                    <td><input value={nd.rev} placeholder="Revision (Rev A)" aria-label="New document revision" onChange={(e) => setNd({ ...nd, rev: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addDoc(); }} /></td>
                    <td colSpan={4} className="muted">The first revision is the document as the tender was priced; nothing is flagged for it.</td>
                    <td><button className="btn" disabled={!nd.title.trim()} onClick={addDoc}>Add document</button></td>
                  </tr>
                )}
                {res.documents.map((d) => (
                  <Fragment key={d.id}>
                    <tr>
                      <td>{d.ref}</td>
                      <td><input key={d.title} defaultValue={d.title} disabled={!editable} aria-label={`Title of ${d.ref}`} onBlur={(e) => e.target.value.trim() !== d.title && editDoc(d.id, "title", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") blur(e); }} /></td>
                      <td><select value={d.category} disabled={!editable} aria-label={`Kind of ${d.ref}`} onChange={(e) => editDoc(d.id, "category", e.target.value)}>{DOC.CATEGORIES.map((c) => <option key={c} value={c}>{DOC.CATEGORY_LABEL[c]}</option>)}</select></td>
                      <td><strong>{d.current?.rev ?? ""}</strong></td>
                      <td className="muted">{d.current?.date ? when(d.current.date) : ""}</td>
                      <td className="muted">{d.current?.addendum}</td>
                      <td className="r">{d.revisions.length}</td>
                      <td className={`r${d.openFlags ? " overdue" : ""}`}>{d.openFlags || ""}</td>
                      <td className="acts">
                        {editable && <button className="btn primary" onClick={() => { setRevFor(revFor === d.id ? null : d.id); setRf({ rev: "", date: "", addendum: "", note: "" }); }}>New revision</button>}
                        <button className="btn" onClick={() => setShowRevs(showRevs === d.id ? null : d.id)}>{showRevs === d.id ? "Hide issues" : "Issues"}</button>
                        {editable && <button className="btn" onClick={() => removeDoc(d)}>Delete</button>}
                      </td>
                    </tr>
                    {revFor === d.id && (
                      <tr className="hist"><td colSpan={9}>
                        <div className="revform">
                          <label>Revision<input value={rf.rev} placeholder="Rev C" autoFocus aria-label="Revision" onChange={(e) => setRf({ ...rf, rev: e.target.value })} /></label>
                          <label>Dated<input type="date" value={rf.date} aria-label="Revision date" onChange={(e) => setRf({ ...rf, date: e.target.value })} /></label>
                          <label>Addendum<input value={rf.addendum} placeholder="Addendum 2" aria-label="Addendum" onChange={(e) => setRf({ ...rf, addendum: e.target.value })} /></label>
                          <label className="grow">What changed<input value={rf.note} placeholder="Stormwater pipe size 300 to 375" aria-label="What changed" onChange={(e) => setRf({ ...rf, note: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addRev(d.id); }} /></label>
                          <button className="btn primary" onClick={() => addRev(d.id)}>Record revision</button>
                          <button className="btn" onClick={() => setRevFor(null)}>Cancel</button>
                        </div>
                      </td></tr>
                    )}
                    {showRevs === d.id && (
                      <tr className="hist"><td colSpan={9}>
                        {[...d.revisions].reverse().map((r, i) => (
                          <div key={r.id} className="revline">
                            <strong>{r.rev}</strong>{i === 0 && <span className="badge solid">Current</span>}
                            <span className="muted">{r.date ? when(r.date) : "undated"}{r.addendum ? ` · ${r.addendum}` : ""}</span>
                            <span>{r.note}</span>
                            {editable && i === 0 && d.revisions.length > 1 && <button className="btn" onClick={() => removeRev(d, r)}>Delete</button>}
                          </div>
                        ))}
                      </td></tr>
                    )}
                  </Fragment>
                ))}
                {res.documents.length === 0 && <tr><td colSpan={9} className="muted">No documents yet.{editable ? " Add the first above." : ""}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        {res.addenda.length > 0 && (
          <section>
            <h3>Addenda <span className="sub">{res.addenda.length}</span></h3>
            <table className="plain" style={{ margin: "8px 12px", width: "calc(100% - 24px)" }}>
              <thead><tr><th style={{ width: 160 }}>Addendum</th><th style={{ width: 110 }}>Dated</th><th>Documents changed</th></tr></thead>
              <tbody>{res.addenda.map((a) => <tr key={a.name}><td>{a.name}</td><td className="muted">{a.date ? when(a.date) : ""}</td><td>{a.items.map((i) => `${i.docRef} ${i.rev}`).join(", ")}</td></tr>)}</tbody>
            </table>
          </section>
        )}

        {clearedFlags.length > 0 && (
          <section>
            <h3>Checked changes <span className="sub">{clearedFlags.length}</span>
              <button className="btn" style={{ marginLeft: "auto" }} onClick={() => setShowCleared((s) => !s)}>{showCleared ? "Hide" : "Show"}</button></h3>
            {showCleared && (
              <div className="sub-pad">
                {clearedFlags.map((f) => (
                  <div key={f.key} className="flagrow done">
                    <span>{f.docRef} {f.rev}: {f.label}</span>
                    <span className="muted">Checked by {f.clear!.by}, {when(f.clear!.at)}: {f.clear!.note}</span>
                    {editable && <button className="btn" onClick={() => ws.removeRow(pkgId, `docclear:${f.key}`)}>Re-open</button>}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
