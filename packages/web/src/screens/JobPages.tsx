import { useConnection } from "../api.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";
import { ConfirmBar } from "./PackageBar.js";
import { PriceStack } from "./PriceStack.js";

const when = (iso: string) => new Date(iso).toLocaleString("en-NZ", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

/** Every package of the job: who has it, at what version, and what you can do with it. */
export function Packages({ ws }: { ws: Workspace }) {
  const { session } = useSession();
  const online = useConnection() === "online";
  const canWrite = session!.role !== "viewer";
  const isManager = session!.role === "manager" || session!.role === "owner";
  return (
    <div className="page">
      <ConfirmBar ws={ws} />
      {ws.notice && <div className={`notice ${ws.notice.kind}`}>{ws.notice.text}<button onClick={ws.dismiss}>Dismiss</button></div>}
      <p className="muted">A package is the part of the estimate one person works on at a time. Check it out before you work, offline or not; check it in when you are done.</p>
      <table className="plain">
        <thead><tr><th>Package</th><th className="r">Version</th><th className="r">Records</th><th>Held by</th><th>Since</th><th className="r">Your changes</th><th /></tr></thead>
        <tbody>
          {ws.packages.map((p) => {
            const mine = ws.isMine(p.id);
            return (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="r num">{p.version}</td>
                <td className="r num">{p.records}</td>
                <td>{p.lock ? <span className={`badge ${mine ? "solid" : "grey"}`}>{mine ? (ws.queued[p.id] ? "You (check-in queued)" : "You") : p.lock.holder_name}</span> : <span className="muted">Free</span>}</td>
                <td className="muted">{p.lock ? when(p.lock.taken_at) : ""}</td>
                <td className="r num">{ws.changes(p.id) || ""}</td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  {!p.lock && <button className="btn" disabled={!canWrite || !online || ws.busy} onClick={() => ws.checkOut(p.id)}>Check out</button>}
                  {mine && !ws.queued[p.id] && <button className="btn primary" disabled={ws.busy} onClick={() => ws.checkIn(p.id)}>{online ? "Check in" : "Check in when online"}</button>}{ws.queued[p.id] && <button className="btn" onClick={() => ws.cancelQueued(p.id)}>Cancel queued check-in</button>}{" "}
                  {mine && <button className="btn" disabled={!online || ws.busy} onClick={() => ws.release(p.id)}>Release</button>}
                  {p.lock && !mine && isManager && <button className="btn" disabled={!online || ws.busy} onClick={() => ws.breakLock(p.id)}>Break lock</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The tender build-up and the consolidated package, as the engine works them out from the records on screen. */
export function Summary({ ws }: { ws: Workspace }) {
  const e = ws.model!.estimate;
  return (
    <div className="page">
      {ws.totalChanges > 0 && <div className="notice warn">These figures include your {ws.totalChanges} unsaved change{ws.totalChanges === 1 ? "" : "s"}, worked out on this computer.</div>}
      <PriceStack model={ws.model!} />
      <h4>Checks</h4>
      <table className="plain">
        <tbody>
          <tr><td>Client price schedule</td><td className="r">{e.schedule.reconciles ? <span className="badge">Reconciles to the all-in</span> : <span className="badge solid">Does not reconcile</span>}</td></tr>
          <tr><td>Risk Truth release gate</td><td className="r"><span className={`badge ${e.riskTruth.gate.startsWith("PASS") ? "" : "solid"}`}>{e.riskTruth.gate}</span></td></tr>
          <tr><td>Scope coverage</td><td className="r"><span className="badge grey">{e.scope.gate}</span></td></tr>
          <tr><td>Build-up rows needing attention</td><td className="r num">{Object.entries(e.qaCounts).filter(([k]) => k !== "OK").reduce((n, [, v]) => n + v, 0)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}
