/** The enquiry register and the contact list, with no screen in them: stages, deadlines, filtering and ordering. */

export interface EnquiryJob {
  id: string; name: string; client: string; status: string; created_at: string;
  contact_id: string | null; due_at: string | null; owner_id: string | null; owner_name: string | null;
  notes: string; approx_value: string; decision_reason: string; decided_at: string | null;
}

export interface ContactRow {
  id: string; name: string; kind: string; person: string; phone: string; email: string; trade: string; notes: string;
  archived_at: string | null; jobs: number;
}

export const STAGE_LABEL: Record<string, string> = { enquiry: "Enquiry", tender: "Tendering", issued: "Issued", awarded: "Awarded", lost: "Lost", "no-bid": "No bid" };
export const KIND_LABEL: Record<string, string> = { client: "Client", consultant: "Consultant", subcontractor: "Subcontractor", supplier: "Supplier", other: "Other" };
export const KINDS = Object.keys(KIND_LABEL);

export type Filter = "open" | "all" | "enquiry" | "tender" | "issued" | "closed";
export const FILTERS: { key: Filter; label: string; match: (status: string) => boolean }[] = [
  { key: "open", label: "Open", match: (s) => s === "enquiry" || s === "tender" },
  { key: "enquiry", label: "Enquiries", match: (s) => s === "enquiry" },
  { key: "tender", label: "Tendering", match: (s) => s === "tender" },
  { key: "issued", label: "Issued", match: (s) => s === "issued" },
  { key: "closed", label: "Won, lost, no bid", match: (s) => s === "awarded" || s === "lost" || s === "no-bid" },
  { key: "all", label: "All", match: () => true },
];

/** The date part of a stored deadline. Deadlines are calendar dates, kept as midnight UTC, so every time zone reads the same date. */
export const dueDate = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

const dayNumber = (ymd: string) => { const [y, m, d] = ymd.split("-").map(Number); return Math.round(Date.UTC(y!, m! - 1, d!) / 86_400_000); };
const localYmd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Whole days from today to the deadline: negative when it has passed, null with no deadline. */
export function daysToGo(due: string | null, now: Date): number | null {
  return due ? dayNumber(dueDate(due)) - dayNumber(localYmd(now)) : null;
}

export function dueText(due: string | null, now: Date): string {
  const n = daysToGo(due, now);
  if (n === null) return "";
  if (n === 0) return "Due today";
  if (n === 1) return "Due tomorrow";
  if (n > 1) return `${n} days to go`;
  return n === -1 ? "1 day overdue" : `${-n} days overdue`;
}

/** The deadline matters only while the job is still open (an enquiry or a tender being prepared). */
export const isOpen = (status: string) => status === "enquiry" || status === "tender";

/** Open work by deadline, soonest first, no deadline last; everything else newest first. */
export function arrange(jobs: EnquiryJob[], filter: Filter): EnquiryJob[] {
  const f = FILTERS.find((x) => x.key === filter)!;
  const byNew = (a: EnquiryJob, b: EnquiryJob) => b.created_at.localeCompare(a.created_at);
  const rows = jobs.filter((j) => f.match(j.status));
  const open = rows.filter((j) => isOpen(j.status)).sort((a, b) => (a.due_at && b.due_at ? a.due_at.localeCompare(b.due_at) || byNew(a, b) : a.due_at ? -1 : b.due_at ? 1 : byNew(a, b)));
  return [...open, ...rows.filter((j) => !isOpen(j.status)).sort(byNew)];
}

export function pipeline(jobs: EnquiryJob[]): Record<string, number> {
  const out: Record<string, number> = { enquiry: 0, tender: 0, issued: 0, awarded: 0, lost: 0, "no-bid": 0 };
  for (const j of jobs) out[j.status] = (out[j.status] ?? 0) + 1;
  return out;
}

export function filterContacts(list: ContactRow[], kind: string, q: string): ContactRow[] {
  const t = q.trim().toLowerCase();
  return list.filter((c) => (kind === "all" || c.kind === kind) && (!t || [c.name, c.person, c.phone, c.email, c.trade, c.notes].some((x) => x.toLowerCase().includes(t))));
}

/** Why Go is not available yet, in words; null when it is. */
export function whyNotGo(j: Pick<EnquiryJob, "owner_id" | "due_at">): string | null {
  if (!j.owner_id && !j.due_at) return "Set who owns it and when it is due first.";
  if (!j.owner_id) return "Set who owns it first.";
  if (!j.due_at) return "Set when it is due first.";
  return null;
}
