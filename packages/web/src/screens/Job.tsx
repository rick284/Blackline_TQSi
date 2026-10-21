import { useEffect, useState } from "react";
import { api } from "../api.js";
import { hrefJob, hrefJobs, type View } from "../route.js";
import { useSession } from "../session.js";
import { useWorkspace } from "../workspace.js";
import { CommercialReview } from "./CommercialReview.js";
import { Packages, Summary } from "./JobPages.js";
import { ParkedChanges } from "./Parked.js";
import { Rates } from "./Rates.js";
import { Scope } from "./Scope.js";
import { Shell } from "./Shell.js";
import { Workbench } from "./Workbench.js";

const MODULES: { view: View; label: string }[] = [
  { view: "estimate", label: "Estimate" },
  { view: "packages", label: "Packages" },
  { view: "rates", label: "Rate Library" },
  { view: "scope", label: "Scope Register" },
  { view: "commercial", label: "Commercial Review" },
  { view: "parked", label: "Parked changes" },
  { view: "summary", label: "Summary" },
];
const LATER = ["Contacts and Enquiries", "Tender Documents", "Tender Procurement", "Programme", "Submission", "Contract Setup", "Cost Control"];

export function Job({ jobId, view }: { jobId: string; view: View }) {
  const { session } = useSession();
  const ws = useWorkspace(jobId, session!);
  const [name, setName] = useState("Job");
  useEffect(() => { api<{ name: string }>("GET", `/jobs/${jobId}`).then((j) => setName(j.name)).catch(() => undefined); }, [jobId]);

  const nav = (
    <nav className="nav" aria-label="Modules">
      <h6>This tender</h6>
      {MODULES.map((m) => (
        <a key={m.view} href={hrefJob(jobId, m.view)} className={view === m.view ? "active" : ""} aria-current={view === m.view ? "page" : undefined}>
          {m.label}
          {m.view === "packages" && ws.heldByMe.length > 0 && <small className="badge solid">{ws.heldByMe.length}</small>}
          {m.view === "parked" && ws.parked.length > 0 && <small className="badge solid">{ws.parked.length}</small>}
        </a>
      ))}
      <h6>Coming later</h6>
      {LATER.map((m) => <span key={m} className="later">{m}</span>)}
    </nav>
  );

  return (
    <Shell crumbs={[{ label: "Tender Register", href: hrefJobs() }, { label: name }, { label: MODULES.find((m) => m.view === view)!.label }]} nav={nav} ws={ws} plain={view !== "estimate" && view !== "rates" && view !== "scope" && view !== "commercial"}>
      {ws.loading ? <div className="empty">Loading…</div> : !ws.model ? <div className="notice error">{ws.notice?.text ?? "This job could not be loaded."}</div> :
        view === "estimate" ? <Workbench ws={ws} /> : view === "packages" ? <Packages ws={ws} /> : view === "rates" ? <Rates ws={ws} /> : view === "scope" ? <Scope ws={ws} /> : view === "commercial" ? <CommercialReview ws={ws} /> : view === "parked" ? <ParkedChanges ws={ws} /> : <Summary ws={ws} />}
    </Shell>
  );
}
