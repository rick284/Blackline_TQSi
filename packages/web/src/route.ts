import { useEffect, useState } from "react";

export type View = "estimate" | "packages" | "rates" | "parked" | "summary";
export type Route = { page: "jobs" } | { page: "job"; jobId: string; view: View };

const VIEWS: View[] = ["estimate", "packages", "rates", "parked", "summary"];

export function parseHash(hash: string): Route {
  const m = /^#\/jobs\/([^/]+)(?:\/(\w+))?$/.exec(hash);
  if (!m) return { page: "jobs" };
  const view = VIEWS.includes(m[2] as View) ? (m[2] as View) : "estimate";
  return { page: "job", jobId: m[1]!, view };
}

export const hrefJobs = () => "#/";
export const hrefJob = (jobId: string, view: View = "estimate") => `#/jobs/${jobId}/${view}`;

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
