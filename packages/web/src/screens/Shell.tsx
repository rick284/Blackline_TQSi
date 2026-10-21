import type { ReactNode } from "react";
import { useConnection } from "../api.js";
import { hrefJobs } from "../route.js";
import { useSession } from "../session.js";
import type { Workspace } from "../workspace.js";

/** Title bar with breadcrumb, the content area, and the status bar that is on every screen. */
export function Shell({ crumbs, nav, ws, children, plain }: { crumbs: { label: string; href?: string }[]; nav?: ReactNode; ws?: Workspace; children: ReactNode; plain?: boolean }) {
  const { session, signOut } = useSession();
  return (
    <div className="frame">
      <header className="titlebar">
        <a className="brand" href={hrefJobs()}>BLACKLINE</a>
        <nav className="crumbs" aria-label="Where you are">
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <span aria-hidden>/</span>}
              {c.href ? <a href={c.href}>{c.label}</a> : <span className="here">{c.label}</span>}
            </span>
          ))}
        </nav>
        <span className="spacer" />
        <span className="who">
          <span>{session?.name} · {session?.role}</span>
          <button className="btn" onClick={() => void signOut()}>Sign out</button>
        </span>
      </header>
      <div className={`body${nav ? "" : " solo"}`}>
        {nav}
        <main className={`main${plain ? " plain" : ""}`}>{children}</main>
      </div>
      <StatusBar ws={ws} />
    </div>
  );
}

/**
 * Always visible, always honest. Online and nothing waiting is quiet; a black badge means something needs the person: offline,
 * packages checked out, or changes that have not been checked in.
 */
export function StatusBar({ ws }: { ws?: Workspace }) {
  const conn = useConnection();
  const { session } = useSession();
  const out = ws?.heldByMe.length ?? 0;
  const waiting = ws?.totalChanges ?? 0;
  return (
    <footer className="statusbar" role="status">
      <span className={`badge ${conn === "offline" ? "solid" : ""}`}>{conn === "offline" ? "Offline" : "Online"}</span>
      {ws && (
        <>
          <span className={`badge ${out ? "solid" : ""}`}>{out === 0 ? "Nothing checked out" : `${out} package${out === 1 ? "" : "s"} checked out by you`}</span>
          <span className={`badge ${waiting ? "grey" : ""}`}>{waiting === 0 ? "No changes waiting" : `${waiting} change${waiting === 1 ? "" : "s"} waiting to check in`}</span>
          {ws.fromCache && <span className="badge dashed">Showing the copy saved on this computer</span>}
          <span className="item">Edits are saved on this computer as you make them</span>
        </>
      )}
      <span className="spacer" />
      <span className="item">{session?.orgName}</span>
    </footer>
  );
}
