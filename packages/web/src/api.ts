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
const setConn = (c: Connection) => {
  if (c !== conn) {
    conn = c;
    listeners.forEach((l) => l());
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
  setConn("online");
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? `Request failed (${res.status}).`, json ?? {});
  return json as T;
}
