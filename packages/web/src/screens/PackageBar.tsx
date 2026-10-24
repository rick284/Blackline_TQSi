import type { ReactNode } from "react";
import { useConnection } from "../api.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";

/** A question asked in the page: a bar above the grid with two plain buttons. Nothing opens over the top of the work. */
export function ConfirmBar({ ws }: { ws: Workspace }) {
  if (!ws.ask) return null;
  return (
    <div className="notice warn" role="alertdialog" aria-live="assertive">
      <span>{ws.ask.text}</span>
      <button className="btn primary" style={{ marginLeft: "auto", textDecoration: "none" }} onClick={() => ws.answer(true)}>{ws.ask.label}</button>
      <button className="btn" style={{ marginLeft: 0, textDecoration: "none" }} onClick={() => ws.answer(false)}>Keep working</button>
    </div>
  );
}

/**
 * The toolbar for working on one package: who has it, and check out / check in / release / break. Every screen that edits a package
 * uses this one, so the rules (and the wording) are the same everywhere. `children` are the screen's own buttons.
 */
export function PackageBar({ ws, pkgId, children, bare, quiet }: { ws: Workspace; pkgId: string; children?: ReactNode; bare?: boolean; quiet?: boolean }) {
  const { session } = useSession();
  const online = useConnection() === "online";
  const pkg = ws.pkg(pkgId);
  const mine = ws.isMine(pkgId);
  const editable = ws.canEdit(pkgId);
  const holder = pkg?.lock ? (mine ? "you" : pkg.lock.holder_name) : null;
  const canWrite = session!.role !== "viewer";
  const isManager = session!.role === "manager" || session!.role === "owner";
  const changes = ws.changes(pkgId);
  const queued = !!ws.queued[pkgId];

  return (
    <>
    <div className="toolbar" role="toolbar" aria-label="Package">
      <div className="group">
        <span className="label">Package</span>
        <strong>{pkg?.name ?? "—"}</strong>
        {holder === null ? <span className="badge">Free</span> : mine ? <span className="badge solid">{queued ? "Check-in queued" : "Checked out by you"}</span> : <span className="badge grey">Held by {holder}</span>}
        <span className="muted">v{pkg?.version ?? "—"}</span>
      </div>
      <div className="group">
        <button className="btn primary" disabled={!canWrite || !pkg || !!pkg.lock || !online || ws.busy} onClick={() => ws.checkOut(pkgId)} title={online ? "" : "Checking out needs a connection"}>Check out</button>
        <button className="btn primary" disabled={!mine || ws.busy || queued} onClick={() => ws.checkIn(pkgId)} title={online ? "" : "Offline: this will be queued and sent when you reconnect"}>
          Check in{changes ? ` (${changes})` : ""}{online ? "" : " when online"}
        </button>
        {queued && <button className="btn" onClick={() => ws.cancelQueued(pkgId)}>Cancel queued check-in</button>}
        <button className="btn" disabled={!mine || !online || ws.busy} onClick={() => ws.release(pkgId)}>Release</button>
        {isManager && pkg?.lock && !mine && <button className="btn" disabled={!online || ws.busy} onClick={() => ws.breakLock(pkgId)}>Break lock</button>}
      </div>
      {!bare && <div className="group">
        <button className="btn" disabled={!ws.canUndo} onClick={ws.undo} title="Undo the last change (Ctrl+Z)">Undo</button>
        <button className="btn" disabled={!ws.canRedo} onClick={ws.redo} title="Put back what you undid (Ctrl+Y)">Redo</button>
      </div>}
      {children && <div className="group">{children}</div>}
      {!quiet && editable && <span className="muted">White cells are yours to change. Shaded cells are calculated.</span>}
      {!quiet && !editable && pkg && <span className="muted">{holder === null ? "Check this package out to change it." : mine ? "" : `Read-only: ${holder} has this package.`}</span>}
    </div>
    {!bare && <ConfirmBar ws={ws} />}
    </>
  );
}
