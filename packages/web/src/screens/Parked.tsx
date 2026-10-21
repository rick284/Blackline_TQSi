import { useMemo, useState } from "react";
import { effectiveRecords } from "../lib/draft.js";
import { money } from "../lib/fmt.js";
import { buildModel } from "../lib/model.js";
import { applyParked, compareParked, fieldName, mergeTheirs, REASONS, show, STATUS_TEXT, type Parked, type RecordCompare } from "../lib/parked.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";
import { PackageBar } from "./PackageBar.js";

const when = (iso: string) => new Date(iso).toLocaleString("en-NZ", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const KIND: Record<RecordCompare["kind"], string> = { changed: "Changed", added: "They added this", removed: "They deleted this", same: "No difference" };

/**
 * A check-in the server refused is kept here, never applied. A manager (or the person who made it) compares it with what is there now,
 * sees only what they actually changed against the version they started from, sees what it would do to the price, brings across what is
 * right by checking the package out and taking their values, and marks it dealt with. Nothing here changes the estimate until the
 * package is checked in again.
 */
export function ParkedChanges({ ws }: { ws: Workspace }) {
  const { session } = useSession();
  const isManager = session!.role === "manager" || session!.role === "owner";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = ws.parked.find((p) => p.id === selectedId) ?? ws.parked[0] ?? null;

  if (ws.parked.length === 0)
    return (
      <div className="page">
        <p className="empty" style={{ padding: 0 }}>Nothing is waiting here. When a check-in is refused because a lock was broken or the package had changed, the work is kept here to compare. It is never lost and never applied by itself.</p>
      </div>
    );

  return (
    <div className="main" style={{ overflow: "auto" }}>
      {ws.notice && <div className={`notice ${ws.notice.kind}`} role="alert">{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <div className="page" style={{ maxWidth: "none" }}>
        <table className="plain">
          <thead><tr><th>Package</th><th>Refused check-in from</th><th className="r">Taken at version</th><th>Why it was refused</th><th>When</th><th className="r">Records</th></tr></thead>
          <tbody>
            {ws.parked.map((p) => (
              <tr key={p.id} className={p.id === selected?.id ? "picked" : ""} onClick={() => setSelectedId(p.id)} style={{ cursor: "pointer" }} aria-selected={p.id === selected?.id}>
                <td><strong>{p.package_name}</strong></td>
                <td>{p.holder_name}</td>
                <td className="r num">{p.base_version}</td>
                <td>{REASONS[p.reason] ?? p.reason}</td>
                <td className="muted">{when(p.created_at)}</td>
                <td className="r num">{Object.keys(p.changes.upserts).length + p.changes.deletes.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {selected && <Detail key={selected.id} ws={ws} p={selected} isManager={isManager} />}
      </div>
    </div>
  );
}

function Detail({ ws, p, isManager }: { ws: Workspace; p: Parked; isManager: boolean }) {
  const server = ws.records ?? [];
  const compare = useMemo(() => compareParked(p, server), [p, server]);
  const effective = useMemo(() => effectiveRecords(server, ws.drafts), [server, ws.drafts]);
  const decide = compare.filter((c) => c.kind !== "same");
  const editable = ws.canEdit(p.package_id);

  // what the price would be with this change taken whole, against the checked-in estimate as it stands
  const effect = useMemo(() => {
    const before = buildModel(server).estimate.consolidated.allInTender;
    const after = buildModel(applyParked(server, p)).estimate.consolidated.allInTender;
    return { before, after, diff: after.minus(before) };
  }, [server, p]);

  const nowOf = (recordId: string) => effective.find((r) => r.packageId === p.package_id && r.id === recordId)?.data;
  const taken = (c: RecordCompare, field: string, theirs: unknown) => JSON.stringify((nowOf(c.recordId)?.body as any)?.[field] ?? null) === JSON.stringify(theirs ?? null);
  const takeField = (c: RecordCompare, field: string, value: unknown) => ws.edit(p.package_id, c.recordId, (b) => ({ ...b, [field]: value ?? null }));
  const takeRecord = (c: RecordCompare) => {
    if (c.kind === "removed") ws.adopt(p.package_id, c.recordId, null);
    else if (c.kind === "added") ws.adopt(p.package_id, c.recordId, c.theirs!);
    else { const now = nowOf(c.recordId); if (now) ws.adopt(p.package_id, c.recordId, mergeTheirs(now, c)); }
  };

  return (
    <section style={{ marginTop: 16, border: "1px solid var(--line-strong)", background: "var(--paper)" }}>
      <div style={{ padding: "6px 12px", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", background: "var(--header)", borderBottom: "1px solid var(--line)" }}>
        {p.holder_name}'s refused check-in to {p.package_name}
      </div>
      <PackageBar ws={ws} pkgId={p.package_id}>
        <button className="btn" disabled={!editable || decide.length === 0} onClick={() => decide.forEach(takeRecord)}>Take all of theirs</button>
        {isManager && <button className="btn" disabled={ws.busy} onClick={() => ws.resolveParked(p.id)}>Mark as dealt with</button>}
      </PackageBar>
      <div style={{ padding: 12 }}>
        <p style={{ marginTop: 0 }}>
          {REASONS[p.reason] ?? p.reason} Their edits were made to version {p.base_version}; the package is now at version {ws.pkg(p.package_id)?.version ?? "?"}.
          Only what they changed is shown, so taking their changes does not undo anyone else's work.
        </p>
        <table className="plain" style={{ maxWidth: 520 }}>
          <tbody>
            <tr><td>All-in tender now</td><td className="r num">{money(effect.before)}</td></tr>
            <tr><td>All-in tender if all of their changes were taken</td><td className="r num">{money(effect.after)}</td></tr>
            <tr className="total"><td>Difference</td><td className="r num">{effect.diff.isZero() ? "No change" : `${effect.diff.gt(0) ? "+" : ""}${money(effect.diff)}`}</td></tr>
          </tbody>
        </table>
        {!editable && <p className="muted">To bring any of this across, check the package out first (use Check out above), then take their values. Nothing changes until you check in.</p>}
        {decide.length === 0 && <p className="muted">Their change matches what is there now, so there is nothing to decide. You can mark it as dealt with.</p>}
        {decide.map((c) => (
          <div key={c.recordId} style={{ marginTop: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong>{c.label}</strong>
              <span className={`badge ${c.kind === "changed" ? "grey" : c.kind === "removed" ? "solid" : ""}`}>{KIND[c.kind]}</span>
              {c.kind === "added" && <button className="btn" disabled={!editable || !!nowOf(c.recordId)} onClick={() => takeRecord(c)}>{nowOf(c.recordId) ? "Added" : "Add their record"}</button>}
              {c.kind === "removed" && <button className="btn" disabled={!editable || !nowOf(c.recordId)} onClick={() => takeRecord(c)}>{nowOf(c.recordId) ? "Delete this record" : "Deleted"}</button>}
              {c.kind === "changed" && <button className="btn" disabled={!editable} onClick={() => takeRecord(c)}>Take all of theirs for this record</button>}
            </div>
            {c.note && <div className="muted" style={{ marginTop: 4 }}>{c.note}</div>}
            {c.kind === "changed" && (
              <table className="plain" style={{ marginTop: 6 }}>
                <thead><tr><th>Field</th><th>When they started</th><th>Now</th><th>Theirs</th><th>What it means</th><th /></tr></thead>
                <tbody>
                  {c.fields.map((f) => (
                    <tr key={f.field}>
                      <td>{fieldName(f.field)}</td>
                      <td className="num muted">{f.status === "unknown" ? "not recorded" : show(f.base)}</td>
                      <td className="num">{show(f.current)}</td>
                      <td className="num"><strong>{show(f.theirs)}</strong></td>
                      <td><span className={`badge ${f.status === "both" ? "solid" : f.status === "same-now" ? "dashed" : ""}`}>{STATUS_TEXT[f.status]}</span></td>
                      <td className="r">
                        {taken(c, f.field, f.theirs) ? <span className="badge">{f.status === "same-now" ? "" : "In your draft"}</span> : <button className="btn" disabled={!editable} onClick={() => takeField(c, f.field, f.theirs)}>Use theirs</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
