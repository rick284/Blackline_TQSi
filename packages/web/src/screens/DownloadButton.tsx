import { useState } from "react";
import { ApiError, apiDownload } from "../api.js";
import type { Workspace } from "../workspace.js";

/** Downloads a file from the server and says so (or says what went wrong) in the page's own notice bar. */
export function DownloadButton({ ws, path, label, title, primary }: { ws: Workspace; path: string; label: string; title?: string; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { const name = await apiDownload(path); ws.notify({ kind: "info", text: `Saved ${name}.` }); }
    catch (e) { ws.notify({ kind: "warn", text: e instanceof ApiError ? (e.status === 0 ? "You are offline. Downloads need a connection." : e.message) : "The file could not be downloaded." }); }
    setBusy(false);
  };
  return <button className={`btn${primary ? " primary" : ""}`} disabled={busy} title={title} onClick={() => void go()}>{busy ? "Preparing…" : label}</button>;
}
