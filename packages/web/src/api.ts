/**
 * The API client. Everything goes through `/api` (the dev server proxies it; in production the same origin serves both).
 * `connection` tracks whether the last request reached the server, which is what the status bar's online/offline state shows.
 */
import { useSyncExternalStore } from "react";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export type Connection = "online" | "offline";
let conn: Connection = typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online";
const listeners = new Set<() => void>();
let poll: ReturnType<typeof setInterval> | null = null;
const setConn = (c: Connection) => {
  if (c !== conn) {
    conn = c;
    listeners.forEach((l) => l());
  }
  // The browser's own online event is not enough (the network can be up while the server is down), so while offline, keep asking the
  // server whether it is back. That is what makes queued check-ins go out by themselves.
  if (c === "offline" && !poll && typeof window !== "undefined") {
    poll = setInterval(() => {
      fetch("/api/health", { cache: "no-store" }).then((r) => { if (r.ok) setConn("online"); }).catch(() => undefined);
    }, 4000);
  } else if (c === "online" && poll) {
    clearInterval(poll);
    poll = null;
  }
};
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => setConn("offline"));
  window.addEventListener("online", () => setConn("online"));
}
export const useConnection = (): Connection =>
  useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => conn);

const TOKEN_KEY = "bl:token";
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t: string | null) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };

/** Send a file as the raw request body (the workbook import). Reports a lost connection the same way `api` does. */
export async function apiUpload<T = any>(path: string, file: Blob): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try { res = await fetch(`/api${path}`, { method: "POST", headers, body: file }); } catch { setConn("offline"); throw new ApiError(0, "offline", "No connection to the server."); }
  setConn("online");
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? `Request failed (${res.status}).`, json ?? {});
  return json as T;
}

/** Fetch a file from the server (it needs the sign-in, so a plain link won't do) and save it under the name the server gave it. */
export async function apiDownload(path: string): Promise<string> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try { res = await fetch(`/api${path}`, { headers }); } catch { setConn("offline"); throw new ApiError(0, "offline", "No connection to the server."); }
  setConn("online");
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? `Request failed (${res.status}).`, json ?? {});
  }
  const disp = res.headers.get("content-disposition") ?? "";
  const name = /filename\*=UTF-8''([^;]+)/i.exec(disp)?.[1];
  const filename = name ? decodeURIComponent(name) : /filename="([^"]+)"/i.exec(disp)?.[1] ?? "download";
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return filename;
}

export async function api<T = any>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    setConn("offline");
    throw new ApiError(0, "offline", "No connection to the server.");
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON: a proxy's own error page */ }
  // A gateway that cannot reach the server answers 502/503/504, or a plain 500 that is not our API's JSON error. That is "offline", not a bug.
  if (!res.ok && ([502, 503, 504].includes(res.status) || (res.status === 500 && !json?.error))) {
    setConn("offline");
    throw new ApiError(0, "offline", "No connection to the server.");
  }
  setConn("online");
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? `Request failed (${res.status}).`, json ?? {});
  return json as T;
}
