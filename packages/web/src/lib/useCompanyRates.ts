import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import type { CompanyRate } from "./rateLibrary.js";

/**
 * The company resource library, for the screens that pick from it. It is read when the screen opens and again after anything is saved to it;
 * offline it is simply empty, and a job's own Rate Library carries on working.
 */
export function useCompanyRates() {
  const [rates, setRates] = useState<CompanyRate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    try {
      const r = await api<CompanyRate[]>("GET", "/rates");
      setRates(Array.isArray(r) ? r : []); // an older server answers with its web page, not a list
    } catch { /* offline or not allowed: the job's own library is still there */ }
    setLoaded(true);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { rates, loaded, reload };
}
