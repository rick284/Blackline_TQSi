import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api.js";

export type Role = "owner" | "manager" | "estimator" | "viewer";
export interface Session { userId: string; orgId: string; role: Role; email: string; name: string; orgName: string }

interface Ctx {
  session: Session | null;
  /** True until the first /me answer, so the sign-in page does not flash for someone already signed in. */
  loading: boolean;
  signIn(token: string): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<Ctx>(null as never);
export const useSession = () => useContext(SessionContext);

const CACHE = "bl:session";
const cached = (): Session | null => { try { return JSON.parse(localStorage.getItem(CACHE) ?? "null"); } catch { return null; } };

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!getToken()) { setSession(null); setLoading(false); return; }
    try {
      const me = await api<Session>("GET", "/me");
      try { localStorage.setItem(CACHE, JSON.stringify(me)); } catch { /* ignore */ }
      setSession(me);
    } catch (e) {
      // offline: keep working as the person who was signed in; a rejected token means signed out
      if (e instanceof ApiError && e.status === 0) setSession(cached());
      else { setToken(null); setSession(null); }
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const signIn = useCallback(async (token: string) => { setToken(token); await load(); }, [load]);
  const signOut = useCallback(async () => {
    try { await api("POST", "/auth/logout"); } catch { /* signing out locally anyway */ }
    setToken(null);
    try { localStorage.removeItem(CACHE); } catch { /* ignore */ }
    setSession(null);
  }, []);

  return <SessionContext.Provider value={{ session, loading, signIn, signOut }}>{children}</SessionContext.Provider>;
}
