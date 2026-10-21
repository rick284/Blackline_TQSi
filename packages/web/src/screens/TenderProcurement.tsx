import { Fragment, useEffect, useState } from "react";
import { procurement as P } from "@blackline/tender/core";
import { api, ApiError } from "../api.js";
import type { ContactRow } from "../lib/enquiries.js";
import { money } from "../lib/fmt.js";
import { levelId, newInvite, newPackage, todayYmd, validityText, writeLevel } from "../lib/procurement.js";
import { hrefJob } from "../route.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";
import { PackageBar } from "./PackageBar.js";

const STATUS_BADGE: Record<P.PackageStatus, string> = { "NO QUOTES": "dashed", "TO ADJUDICATE": "grey", SELECTED: "solid", CHECK: "red" };
const when = (ymd: string) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-NZ", { day: "numeric", month: "short", timeZone: "UTC" }) : "");

/**
 * Tender Procurement: the packages out for pricing, who was asked, and the quotes that came back levelled so they compare like for like.
 * A person selects one with a reason. The window ranks, checks the exclusions and shows the difference from what the estimate carries; it never
 * selects, and it never changes the estimate's money. The quotes themselves are kept in the quote register (Scope Register).
 */
export function TenderProcurement({ ws, jobId }: { ws: Workspace; jobId: string }) {
  const { session } = useSession();
  const model = ws.model!;
  const pkgId = model.procurementPackageId;
  const editable = !!pkgId && ws.canEdit(pkgId);
  const res = model.estimate.procurement;
  const today = todayYmd();

  const [open, setOpen] = useState<string | null>(null);
  const [bidOpen, setBidOpen] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [np, setNp] = useState({ name: "", overlay: "" });
  const [ni, setNi] = useState({ supplier: "", due: "" });
  const [adj, setAdj] = useState({ label: "", amount: "" });
  const [ex, setEx] = useState("");
  const [people, setPeople] = useState<ContactRow[]>([]);

  useEffect(() => {
    api<ContactRow[]>("GET", "/contacts").then((c) => setPeople(c.filter((x) => x.kind === "subcontractor" || x.kind === "supplier"))).catch(() => undefined);
  }, []);

  const start = async () => {
    try { await api("POST", `/jobs/${jobId}/procurement`, {}); await ws.load(); } catch (e) { ws.notify({ kind: "warn", text: e instanceof ApiError ? e.message : "Procurement could not be started." }); }
  };

  if (!pkgId) {
    return (
      <div className="page sub-start">
        {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
        <h4>Tender Procurement</h4>
        <p className="muted">The packages that go out to subcontractors and suppliers for pricing, who was asked, and the quotes that come back, levelled so they compare like for like, then one selected with a reason. Start it and a package is made for each name in your quote register, linked to the subcontract package of the same name.</p>
        <button className="btn primary" disabled={session!.role === "viewer"} onClick={start}>Start procurement for this job</button>
      </div>
    );
  }

  const say = (text: string) => ws.notify({ kind: "warn", text });
  const guard = (fn: () => void) => { try { fn(); } catch (e) { say(e instanceof P.ProcurementError ? e.message : "That could not be saved."); } };
  const editPkg = (id: string, change: (p: P.ProcPackage) => P.ProcPackage) => guard(() => ws.edit(pkgId, `pp:${id}`, (b: P.ProcPackage) => change(b)));
  const editInvite = (id: string, field: string, value: unknown) => guard(() => ws.edit(pkgId, `pi:${id}`, (b: P.ProcInvite) => P.setInviteField(b, field, value)));
  const level = (ref: string, change: (l: P.ProcLevel) => P.ProcLevel) => {
    const cur = res.packages.flatMap((p) => p.bids).find((b) => b.ref === ref)?.level;
    const made = writeLevel(cur && (cur.adjustments.length || cur.exclusions.length || cur.note) ? cur : undefined, ref, change);
    if (!made.ok) return say(made.error);
    ws.adopt(pkgId, made.recordId, made.data);
  };

  const pkg = res.packages.find((p) => p.id === open) ?? null;
  const overlays = model.inputs.overlays.map((o) => o.name);
  const allPkgs = res.packages.map(({ invites: _i, inviteCounts: _c, bids: _b, selectedBid: _s, estimate: _e, variance: _v, problems: _p, warnings: _w, status: _st, ...p }) => p as P.ProcPackage);
  const allInvites = res.packages.flatMap((p) => p.invites);

  const addPkg = () => {
    const r = newPackage(np, allPkgs, ws.nextSeq("procPackage"));
    if (!r.ok) return say(r.error);
    ws.adopt(pkgId, r.recordId, r.data); setNp({ name: "", overlay: "" });
  };
  const addInvite = (p: P.PackageResult) => {
    const match = people.find((c) => c.name.toLowerCase() === ni.supplier.trim().toLowerCase());
    const r = newInvite(p.id, { supplier: ni.supplier, contactId: match?.id, sent: today, due: ni.due }, allInvites, ws.nextSeq("procInvite"));
    if (!r.ok) return say(r.error);
    ws.adopt(pkgId, r.recordId, r.data); setNi({ supplier: "", due: "" });
  };
  const choose = (p: P.PackageResult, ref: string) => guard(() => {
    const next = P.select(p, ref, reason, session!.name, new Date().toISOString());
    ws.edit(pkgId, `pp:${p.id}`, () => ({ id: next.id, name: next.name, overlay: next.overlay, scope: next.scope, selected: next.selected, reason: next.reason, by: next.by, at: next.at }));
    setReason("");
  });
  const removePkg = (p: P.PackageResult) => {
    const items = [{ recordId: `pp:${p.id}`, data: null }, ...p.invites.map((i) => ({ recordId: `pi:${i.id}`, data: null })), ...p.bids.filter((b) => ws.record(levelId(b.ref))).map((b) => ({ recordId: levelId(b.ref), data: null }))];
    ws.confirm(`Delete the package ${p.name} with its ${p.invites.length} invite${p.invites.length === 1 ? "" : "s"} and levelling? The quotes stay in the quote register. Undo brings it back until you check in.`, "Delete package", () => ws.batch(pkgId, items));
  };

  const blur = (e: { currentTarget: HTMLInputElement }) => e.currentTarget.blur();

  return (
    <>
      <PackageBar ws={ws} pkgId={pkgId} />
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="docs">
        <div className="pipeline">
          <span><strong>{res.packages.length}</strong> package{res.packages.length === 1 ? "" : "s"}</span>
          <span className={res.blocking ? "overdue" : "muted"}>{res.gate}</span>
          <span className="muted">Quotes are kept in the quote register. <a href={hrefJob(jobId, "scope")}>Scope Register</a></span>
        </div>

        <section>
          <h3>Packages out for pricing</h3>
          <div className="tablewrap">
            <table className="plain reg">
              <thead>
                <tr><th style={{ width: 220 }}>Package</th><th style={{ width: 150 }}>Estimate package</th><th style={{ width: 130 }}>Invites</th><th className="r" style={{ width: 60 }}>Quotes</th>
                  <th className="r" style={{ width: 120 }}>Lowest levelled $</th><th style={{ width: 190 }}>Selected</th><th className="r" style={{ width: 110 }}>Against estimate $</th><th style={{ width: 120 }}>Status</th><th style={{ width: 150 }} /></tr>
              </thead>
              <tbody>
                {editable && (
                  <tr className="new">
                    <td><input value={np.name} placeholder="New package: name" aria-label="New package name" onChange={(e) => setNp({ ...np, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addPkg(); }} /></td>
                    <td><select value={np.overlay} aria-label="New package estimate package" onChange={(e) => setNp({ ...np, overlay: e.target.value })}><option value="">Not linked</option>{overlays.map((o) => <option key={o} value={o}>{o}</option>)}</select></td>
                    <td colSpan={6} className="muted">Quotes join a package when their package name in the quote register is the same.</td>
                    <td><button className="btn" disabled={!np.name.trim()} onClick={addPkg}>Add package</button></td>
                  </tr>
                )}
                {res.packages.map((p) => {
                  const low = p.bids.find((b) => b.lowest);
                  return (
                    <tr key={p.id} className={open === p.id ? "picked" : ""}>
                      <td><strong>{p.name}</strong></td>
                      <td>
                        {editable
                          ? <select value={p.overlay} aria-label={`Estimate package for ${p.name}`} onChange={(e) => editPkg(p.id, (b) => P.setPackageField(b, "overlay", e.target.value))}><option value="">Not linked</option>{overlays.map((o) => <option key={o} value={o}>{o}</option>)}</select>
                          : <span className="muted">{p.overlay}</span>}
                        {p.estimate ? <div className="muted">{money(p.estimate)} in the estimate</div> : null}
                      </td>
                      <td className="muted">{p.invites.length === 0 ? "" : `${p.inviteCounts.quoted} quoted of ${p.invites.length}${p.inviteCounts.invited ? `, ${p.inviteCounts.invited} waiting` : ""}`}</td>
                      <td className="r">{p.bids.length || ""}</td>
                      <td className="r">{low ? money(low.levelled) : ""}</td>
                      <td>{p.selectedBid ? `${p.selectedBid.supplier || p.selectedBid.ref} · ${money(p.selectedBid.levelled)}` : p.selected ? <span className="overdue">{p.selected} missing</span> : ""}</td>
                      <td className={`r${p.variance && p.variance.abs().gte("0.005") ? " overdue" : ""}`}>{p.variance ? `${p.variance.gt(0) ? "+" : ""}${money(p.variance)}` : ""}</td>
                      <td><span className={`badge ${STATUS_BADGE[p.status]}`}>{p.status === "TO ADJUDICATE" ? "To choose" : p.status === "NO QUOTES" ? "No quotes" : p.status === "CHECK" ? "Check" : "Selected"}</span></td>
                      <td className="acts">
                        <button className="btn primary" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? "Close" : "Open"}</button>
                        {editable && <button className="btn" onClick={() => removePkg(p)}>Delete</button>}
                      </td>
                    </tr>
                  );
                })}
                {res.packages.length === 0 && <tr><td colSpan={9} className="muted">No packages yet.{editable ? " Add one above." : ""}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        {pkg && (
          <>
            <section>
              <h3>{pkg.name}: who was asked <span className="sub">{pkg.invites.length}</span></h3>
              <div className="tablewrap">
                <table className="plain reg">
                  <thead><tr><th style={{ width: 240 }}>Supplier</th><th style={{ width: 90 }}>Sent</th><th style={{ width: 140 }}>Due</th><th style={{ width: 140 }}>Answer</th><th>Note</th><th style={{ width: 90 }} /></tr></thead>
                  <tbody>
                    {editable && (
                      <tr className="new">
                        <td><input list="proc-people" value={ni.supplier} placeholder="Ask a supplier: name" aria-label="Supplier to ask" onChange={(e) => setNi({ ...ni, supplier: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") addInvite(pkg); }} />
                          <datalist id="proc-people">{people.map((c) => <option key={c.id} value={c.name} />)}</datalist></td>
                        <td className="muted">{when(today)}</td>
                        <td><input type="date" value={ni.due} aria-label="Quote due date" onChange={(e) => setNi({ ...ni, due: e.target.value })} /></td>
                        <td colSpan={2} className="muted">Pick from your contacts or type a name.</td>
                        <td><button className="btn" disabled={!ni.supplier.trim()} onClick={() => addInvite(pkg)}>Add</button></td>
                      </tr>
                    )}
                    {pkg.invites.map((i) => {
                      const late = i.status === "invited" && i.due && i.due < today;
                      return (
                        <tr key={i.id}>
                          <td>{i.supplier}</td>
                          <td className="muted">{when(i.sent)}</td>
                          <td><input type="date" key={i.due} defaultValue={i.due} disabled={!editable} aria-label={`Due date for ${i.supplier}`} onBlur={(e) => e.target.value !== i.due && editInvite(i.id, "due", e.target.value)} />{late && <span className="overdue"> overdue</span>}</td>
                          <td><select value={i.status} disabled={!editable} aria-label={`Answer from ${i.supplier}`} onChange={(e) => editInvite(i.id, "status", e.target.value)}>{P.INVITE_STATUSES.map((s) => <option key={s} value={s}>{P.INVITE_LABEL[s]}</option>)}</select></td>
                          <td><input key={i.note} defaultValue={i.note} disabled={!editable} aria-label={`Note on ${i.supplier}`} onBlur={(e) => e.target.value.trim() !== i.note && editInvite(i.id, "note", e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") blur(e); }} /></td>
                          <td>{editable && <button className="btn" onClick={() => ws.removeRow(pkgId, `pi:${i.id}`)}>Delete</button>}</td>
                        </tr>
                      );
                    })}
                    {pkg.invites.length === 0 && <tr><td colSpan={6} className="muted">Nobody recorded as asked yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h3>{pkg.name}: quotes levelled <span className="sub">lowest levelled first; the quoted amount plus your adjustments</span></h3>
              {editable && pkg.bids.length > 0 && (
                <div className="sub-pad" style={{ flexDirection: "row", alignItems: "center" }}>
                  <span className="muted">Reason for selecting</span>
                  <input value={reason} placeholder="Why this quote is the one" aria-label="Reason for selecting" style={{ flex: 1, maxWidth: 520, height: 24, padding: "0 6px", border: "1px solid var(--line-strong)", borderRadius: 0, font: "inherit" }} onChange={(e) => setReason(e.target.value)} />
                </div>
              )}
              {pkg.selectedBid && <p className="muted" style={{ margin: "4px 12px" }}>Selected {pkg.selectedBid.ref} by {pkg.by || "someone"}: {pkg.reason}</p>}
              {pkg.problems.map((t) => <div key={t} className="notice error">{t}</div>)}
              {pkg.warnings.map((t) => <div key={t} className="notice warn">{t}</div>)}
              <div className="tablewrap">
                <table className="plain reg">
                  <thead>
                    <tr><th style={{ width: 70 }}>Quote</th><th style={{ width: 200 }}>Supplier</th><th className="r" style={{ width: 110 }}>Quoted $</th><th className="r" style={{ width: 110 }}>Adjustments $</th><th className="r" style={{ width: 120 }}>Levelled $</th>
                      <th style={{ width: 60 }}>Place</th><th style={{ width: 140 }}>Valid</th><th style={{ width: 120 }}>Exclusions</th><th style={{ width: 210 }} /></tr>
                  </thead>
                  <tbody>
                    {[...pkg.bids].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.ref.localeCompare(b.ref)).map((b) => {
                      const v = validityText(b.validUntil, today);
                      const sel = pkg.selected.toUpperCase() === b.ref.toUpperCase();
                      return (
                        <Fragment key={b.ref}>
                          <tr className={sel ? "picked" : ""}>
                            <td>{b.ref}</td>
                            <td>{b.supplier}</td>
                            <td className="r">{b.amountOk ? money(b.quoted) : <span className="overdue">no amount</span>}</td>
                            <td className="r">{b.adjustments.isZero() ? "" : `${b.adjustments.gt(0) ? "+" : ""}${money(b.adjustments)}`}</td>
                            <td className="r"><strong>{b.amountOk ? money(b.levelled) : ""}</strong></td>
                            <td>{b.rank ? <span className={`badge ${b.lowest ? "solid" : ""}`}>{b.rank}</span> : ""}</td>
                            <td className={v.expired ? "overdue" : "muted"}>{v.text}</td>
                            <td className={b.unresolved ? "overdue" : "muted"}>{b.exclusions ? `${b.exclusions}${b.unresolved ? `, ${b.unresolved} open` : ""}` : ""}</td>
                            <td className="acts">
                              {editable && (sel ? <button className="btn" onClick={() => choose(pkg, "")}>Clear selection</button> : <button className="btn primary" disabled={!b.amountOk} onClick={() => choose(pkg, b.ref)}>Select</button>)}
                              <button className="btn" onClick={() => setBidOpen(bidOpen === b.ref ? null : b.ref)}>{bidOpen === b.ref ? "Close" : "Level"}</button>
                            </td>
                          </tr>
                          {bidOpen === b.ref && (
                            <tr className="hist"><td colSpan={9}>
                              <div className="levelgrid">
                                <div>
                                  <h4>Adjustments to compare like for like</h4>
                                  {b.level.adjustments.map((a, i) => (
                                    <div key={i} className="revline"><span style={{ flex: 1 }}>{a.label}</span><span className="num">{Number(a.amount) > 0 ? "+" : ""}{money(a.amount)}</span>
                                      {editable && <button className="btn" onClick={() => level(b.ref, (l) => P.removeAdjustment(l, i))}>Delete</button>}</div>
                                  ))}
                                  {b.level.adjustments.length === 0 && <div className="muted">None.</div>}
                                  {editable && (
                                    <div className="revform" style={{ marginTop: 6 }}>
                                      <label className="grow">Add or remove<input value={adj.label} placeholder="Add: traffic management they exclude" aria-label="Adjustment label" onChange={(e) => setAdj({ ...adj, label: e.target.value })} /></label>
                                      <label>Amount $<input value={adj.amount} placeholder="4500 or -1200" aria-label="Adjustment amount" style={{ width: 110, textAlign: "right" }} onChange={(e) => setAdj({ ...adj, amount: e.target.value })}
                                        onKeyDown={(e) => { if (e.key === "Enter") { level(b.ref, (l) => P.addAdjustment(l, adj)); setAdj({ label: "", amount: "" }); } }} /></label>
                                      <button className="btn" onClick={() => { level(b.ref, (l) => P.addAdjustment(l, adj)); setAdj({ label: "", amount: "" }); }}>Add</button>
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <h4>Exclusions the quote states</h4>
                                  {b.level.exclusions.map((x, i) => (
                                    <div key={i} className="exline">
                                      <span style={{ flex: 1 }}>{x.text}</span>
                                      <select value={x.treatment} disabled={!editable} aria-label={`Treatment of ${x.text}`} onChange={(e) => level(b.ref, (l) => P.setExclusion(l, i, "treatment", e.target.value))}>
                                        <option value="">Not dealt with</option>{P.TREATMENTS.map((t) => <option key={t} value={t}>{t}</option>)}
                                      </select>
                                      {editable && <button className="btn" onClick={() => level(b.ref, (l) => P.removeExclusion(l, i))}>Delete</button>}
                                    </div>
                                  ))}
                                  {b.level.exclusions.length === 0 && <div className="muted">None recorded.</div>}
                                  {editable && (
                                    <div className="revform" style={{ marginTop: 6 }}>
                                      <label className="grow">Exclusion<input value={ex} placeholder="Rock excavation" aria-label="New exclusion" onChange={(e) => setEx(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { level(b.ref, (l) => P.addExclusion(l, ex)); setEx(""); } }} /></label>
                                      <button className="btn" onClick={() => { level(b.ref, (l) => P.addExclusion(l, ex)); setEx(""); }}>Add</button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                    {pkg.bids.length === 0 && <tr><td colSpan={9} className="muted">No quotes in the register for this package yet. Add them in the Scope Register with the package name “{pkg.name}”.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}
