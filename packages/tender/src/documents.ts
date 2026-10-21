/**
 * Tender documents: the drawings, specifications, client BOQ and reports a tender is priced from, each with its revisions, and the change
 * flags a new revision raises.
 *
 *   document   a thing the tender is priced from (DOC-01 Civil drawings). The ref is the one the scope register and the quotes already cite.
 *   revision   one issue of it (Rev C, from Addendum 2). Revisions are only ever added; the latest is current and the earlier ones stay.
 *   flag       raised by every revision after a document's first, for each thing that depends on the document: the scope items that cite it,
 *              the estimate lines those scope items carry, the quotes based on it. If nothing cites the document the flag says so, because
 *              then nobody knows what the change touches. A flag stays open until a person has looked and cleared it, with a note.
 *
 * The platform never decides that a change is harmless: it finds what to look at and holds the tender until someone has.
 */
import type { SeedPackage } from "./packaging.js";
import { type RegisterItem } from "./register.js";
import type { Quote } from "./quotes.js";
import { tokens, type ScopeItem } from "./scope.js";

export const CATEGORIES = ["drawing", "specification", "boq", "report", "correspondence", "other"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = { drawing: "Drawing", specification: "Specification", boq: "Client BOQ", report: "Report", correspondence: "Correspondence", other: "Other" };

export interface TenderDoc { id: string; ref: string; title: string; category: Category; note: string }
export interface DocRevision { id: string; docId: string; rev: string; date: string; addendum: string; note: string }
export interface FlagClear { revId: string; target: string; note: string; by: string; at: string }
export interface DocumentsInput { docs: (TenderDoc & { seq?: number })[]; revisions: (DocRevision & { seq?: number })[]; clears: FlagClear[] }

export class DocumentError extends Error {}

const LIMITS = { ref: 40, title: 300, note: 1000, rev: 40, addendum: 100 } as const;

const clip = (v: unknown, max: number, what: string) => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw new DocumentError(`${what} is too long (limit ${max} characters).`);
  return s;
};

const validDate = (s: string) => s === "" || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s);

export function setDocField(d: TenderDoc, field: string, value: unknown): TenderDoc {
  if (field === "category") {
    const v = String(value ?? "").trim().toLowerCase();
    if (!(CATEGORIES as readonly string[]).includes(v)) throw new DocumentError(`Category must be one of: ${CATEGORIES.join(", ")}.`);
    return { ...d, category: v as Category };
  }
  if (field === "title") {
    const v = clip(value, LIMITS.title, "The title");
    if (!v) throw new DocumentError("A document needs a title.");
    return { ...d, title: v };
  }
  if (field === "note") return { ...d, note: clip(value, LIMITS.note, "The note") };
  if (field === "ref") {
    const v = clip(value, LIMITS.ref, "The reference").toUpperCase();
    if (!v) throw new DocumentError("A document needs a reference.");
    return { ...d, ref: v };
  }
  throw new DocumentError(`'${field}' can't be edited on a document.`);
}

export function buildDocument(id: string, v: { title: unknown; category?: unknown; ref?: unknown; note?: unknown }, existing: Pick<TenderDoc, "ref">[]): TenderDoc {
  const title = clip(v.title, LIMITS.title, "The title");
  if (!title) throw new DocumentError("Name the document.");
  let ref = clip(v.ref, LIMITS.ref, "The reference").toUpperCase();
  if (!ref) {
    const nums = existing.map((x) => /(\d+)\s*$/.exec(x.ref)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1]));
    ref = `DOC-${String(1 + Math.max(0, ...nums)).padStart(2, "0")}`;
  }
  if (existing.some((x) => x.ref.toUpperCase() === ref)) throw new DocumentError(`${ref} is already used.`);
  const category = String(v.category ?? "drawing").toLowerCase();
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new DocumentError(`Category must be one of: ${CATEGORIES.join(", ")}.`);
  return { id, ref, title, category: category as Category, note: clip(v.note, LIMITS.note, "The note") };
}

/** A new issue of a document. The revision label can't repeat for the same document; the date is optional but must be a real date. */
export function buildRevision(id: string, docId: string, v: { rev: unknown; date?: unknown; addendum?: unknown; note?: unknown }, existing: Pick<DocRevision, "docId" | "rev">[]): DocRevision {
  const rev = clip(v.rev, LIMITS.rev, "The revision");
  if (!rev) throw new DocumentError("Say which revision this is, for example Rev C.");
  if (existing.some((x) => x.docId === docId && x.rev.toLowerCase() === rev.toLowerCase())) throw new DocumentError(`${rev} has already been recorded for this document.`);
  const date = String(v.date ?? "").trim();
  if (!validDate(date)) throw new DocumentError("The date needs to be a real date, for example 2026-11-12.");
  return { id, docId, rev, date, addendum: clip(v.addendum, LIMITS.addendum, "The addendum"), note: clip(v.note, LIMITS.note, "The note") };
}

export interface DocFlag {
  key: string;
  revId: string;
  docId: string;
  docRef: string;
  docTitle: string;
  rev: string;
  addendum: string;
  revNote: string;
  kind: "scope" | "cost" | "quote" | "unlinked";
  target: string;
  label: string;
  open: boolean;
  clear?: FlagClear;
}

export interface DocResult {
  documents: (TenderDoc & { revisions: DocRevision[]; current: DocRevision | null; openFlags: number })[];
  flags: DocFlag[];
  open: number;
  addenda: { name: string; date: string; items: { docRef: string; rev: string }[] }[];
  gate: string;
}

export const flagKey = (revId: string, target: string) => `${revId}|${target}`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The quote's own "documents" wording cites the document by its reference (DOC-01 matches DOC-01 and not DOC-010). */
const cites = (text: string, ref: string) => new RegExp(`(^|[^A-Z0-9-])${escape(ref.toUpperCase())}($|[^A-Z0-9-])`).test(text.toUpperCase());

export function computeDocuments(input: DocumentsInput | null | undefined, scope: ScopeItem[], quotes: Quote[], costLabels: Record<string, string> = {}): DocResult {
  const docs = [...(input?.docs ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const revs = [...(input?.revisions ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const clears = new Map((input?.clears ?? []).map((c) => [flagKey(c.revId, c.target), c]));
  const flags: DocFlag[] = [];

  const documents = docs.map((d) => {
    const mine = revs.filter((r) => r.docId === d.id);
    const citing = scope.filter((s) => tokens(s.register_refs).includes(d.ref.toUpperCase()));
    const costs = [...new Set(citing.flatMap((s) => tokens(s.cost_refs)))];
    const quoteRefs = new Set(citing.flatMap((s) => tokens(s.quote_refs)));
    const dependent = quotes.filter((q) => q.ref && (quoteRefs.has(q.ref.toUpperCase()) || cites(q.documents, d.ref)));
    const targets: Pick<DocFlag, "kind" | "target" | "label">[] = citing.length === 0 && dependent.length === 0
      ? [{ kind: "unlinked", target: `unlinked:${d.ref}`, label: `No scope item or quote cites ${d.ref}, so nothing says what this change touches. Link it, or confirm nothing depends on it.` }]
      : [
        ...citing.map((s) => ({ kind: "scope" as const, target: `scope:${s.ref}`, label: `Scope ${s.ref}: ${s.title}` })),
        ...costs.map((c) => ({ kind: "cost" as const, target: `cost:${c}`, label: `Estimate line ${c}${costLabels[c] ? `: ${costLabels[c]}` : ""}` })),
        ...dependent.map((q) => ({ kind: "quote" as const, target: `quote:${q.ref}`, label: `Quote ${q.ref}: ${q.supplier || q.package}` })),
      ];
    // the first revision is the document as received: only the revisions after it are changes
    mine.slice(1).forEach((r) => {
      for (const t of targets) {
        const key = flagKey(r.id, t.target);
        const clear = clears.get(key);
        flags.push({ key, revId: r.id, docId: d.id, docRef: d.ref, docTitle: d.title, rev: r.rev, addendum: r.addendum, revNote: r.note, ...t, open: !clear, ...(clear ? { clear } : {}) });
      }
    });
    return { ...d, revisions: mine, current: mine[mine.length - 1] ?? null, openFlags: 0 };
  });
  for (const d of documents) d.openFlags = flags.filter((f) => f.docId === d.id && f.open).length;

  const byAddendum = new Map<string, { name: string; date: string; items: { docRef: string; rev: string }[] }>();
  for (const d of documents) for (const r of d.revisions) {
    if (!r.addendum) continue;
    const a = byAddendum.get(r.addendum) ?? { name: r.addendum, date: "", items: [] };
    if (r.date && (!a.date || r.date > a.date)) a.date = r.date;
    a.items.push({ docRef: d.ref, rev: r.rev });
    byAddendum.set(r.addendum, a);
  }
  const open = flags.filter((f) => f.open).length;
  const gate = docs.length === 0 ? "NOT STARTED - no documents recorded"
    : open ? `HOLD - ${open} document change${open === 1 ? "" : "s"} not yet checked`
    : "PASS - every document change has been checked against what it touches";
  return { documents, flags, open, addenda: [...byAddendum.values()].sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)), gate };
}

/** The "Tender Documents" package a job is started with, seeded from its register. Asking again for a job that has one changes nothing (the server checks). */
export function documentsPackage(register: RegisterItem[]): SeedPackage {
  const s = documentsSeed(register);
  return { key: "documents", name: "Tender Documents", kind: "documents", records: { ...s.docs, ...s.revisions } };
}

// ---- starting a job's document register from the tender register -----------------------------------------------------------------------------
const guessCategory = (title: string): Category => {
  const t = title.toLowerCase();
  if (/\b(plans?|drawings?|dwg)\b/.test(t)) return "drawing";
  if (/\bspec/.test(t)) return "specification";
  if (/\b(boq|bill of quantities|schedule of quantities)\b/.test(t)) return "boq";
  if (/(report|assessment|geotech|\bgir\b|ground information)/.test(t)) return "report";
  if (/\b(emails?|letters?|clarifications?)\b/.test(t)) return "correspondence";
  return "other";
};

/**
 * The first revision of each document, taken from the register's document items (whose `detail` starts with the revision or date the estimate was
 * priced on). Nothing is flagged for these: they are the documents as the tender was priced.
 */
export function documentsSeed(register: RegisterItem[]): { docs: Record<string, { kind: string; seq: number; body: TenderDoc }>; revisions: Record<string, { kind: string; seq: number; body: DocRevision }> } {
  const docs: Record<string, { kind: string; seq: number; body: TenderDoc }> = {}, revisions: Record<string, { kind: string; seq: number; body: DocRevision }> = {};
  register.filter((x) => x.kind === "document").forEach((x, i) => {
    const id = `D${i + 1}`;
    const first = (x.detail.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 40);
    docs[`doc:${id}`] = { kind: "tenderDoc", seq: (i + 1) * 1000, body: { id, ref: x.ref.toUpperCase(), title: x.title, category: guessCategory(x.title), note: "" } };
    revisions[`docrev:${id}-1`] = { kind: "tenderDocRev", seq: (i + 1) * 1000, body: { id: `${id}-1`, docId: id, rev: first || "As received", date: "", addendum: "", note: "From the tender register" } };
  });
  return { docs, revisions };
}
