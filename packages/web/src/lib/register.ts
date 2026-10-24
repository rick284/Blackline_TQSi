/** The Tender Register's own rules, with no screen in them: which jobs show, the totals above the list, and the name a copy is given. */
import { D } from "@blackline/engine";
import { type EnquiryJob, isOpen } from "./enquiries.js";

export interface RegisterJob extends EnquiryJob { archived_at: string | null }

export type RegisterView = "open" | "issued" | "awarded" | "closed" | "all" | "archived";
export const REGISTER_VIEWS: { key: RegisterView; label: string }[] = [
  { key: "open", label: "Open (enquiry and tendering)" },
  { key: "issued", label: "Issued" },
  { key: "awarded", label: "Awarded" },
  { key: "closed", label: "Lost and no bid" },
  { key: "all", label: "All" },
  { key: "archived", label: "Archived" },
];

const MATCH: Record<RegisterView, (j: RegisterJob) => boolean> = {
  open: (j) => !j.archived_at && isOpen(j.status),
  issued: (j) => !j.archived_at && j.status === "issued",
  awarded: (j) => !j.archived_at && j.status === "awarded",
  closed: (j) => !j.archived_at && (j.status === "lost" || j.status === "no-bid"),
  all: (j) => !j.archived_at,
  archived: (j) => !!j.archived_at,
};

/** The jobs to show: the chosen view, narrowed by what was typed (name, client, owner or notes), newest first. */
export function visible(jobs: RegisterJob[], view: RegisterView, q: string): RegisterJob[] {
  const t = q.trim().toLowerCase();
  return jobs
    .filter((j) => MATCH[view](j) && (!t || [j.name, j.client, j.owner_name ?? "", j.notes].some((x) => x.toLowerCase().includes(t))))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export interface RegisterSummary { open: number; issued: number; awarded: number; closed: number; archived: number; pipeline: string; dueSoon: number }

/** The counts across the top. The pipeline is the approximate value of what is still open, from the values people typed in. */
export function summarise(jobs: RegisterJob[], dueSoon: (j: RegisterJob) => boolean = () => false): RegisterSummary {
  const live = jobs.filter((j) => !j.archived_at);
  const open = live.filter((j) => isOpen(j.status));
  return {
    open: open.length,
    issued: live.filter((j) => j.status === "issued").length,
    awarded: live.filter((j) => j.status === "awarded").length,
    closed: live.filter((j) => j.status === "lost" || j.status === "no-bid").length,
    archived: jobs.length - live.length,
    pipeline: open.reduce((s, j) => (/^\d+(\.\d+)?$/.test(j.approx_value) ? s.plus(j.approx_value) : s), new D(0)).toString(),
    dueSoon: open.filter(dueSoon).length,
  };
}

/** "Name (copy)", then "Name (copy 2)" and so on, whichever is free. */
export function copyName(name: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  const base = name.replace(/ \(copy(?: \d+)?\)$/, "");
  for (let i = 1; ; i++) {
    const n = i === 1 ? `${base} (copy)` : `${base} (copy ${i})`;
    if (!taken.has(n.toLowerCase())) return n;
  }
}

/** A name for a job made from a workbook's file name: no extension, underscores read as spaces. */
export const nameFromFile = (file: string) => file.replace(/\.xlsx$/i, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
