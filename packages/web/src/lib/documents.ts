/**
 * Tender Documents edits, with no screen in them: a new document with its first revision, a new revision, and clearing (or re-opening) a change
 * flag. Each returns the records to write, or says what is wrong in words. The rules themselves are in the shared tender package.
 */
import { documents as DOC, type RecordData } from "@blackline/tender/core";

export type TenderDoc = DOC.TenderDoc;
export type DocRevision = DOC.DocRevision;
export type DocFlag = DOC.DocFlag;
export type Items = { ok: true; items: { recordId: string; data: RecordData }[] } | { ok: false; error: string };

const free = (prefix: string, taken: Set<string>) => { for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`; };
const fail = (e: unknown): { ok: false; error: string } => ({ ok: false, error: e instanceof DOC.DocumentError ? e.message : "That could not be recorded." });

/** A document with its first revision (the document as received). Nothing is flagged for a first revision. */
export function newDocument(v: { title: string; category: string; rev: string; date?: string }, docs: TenderDoc[], revs: DocRevision[], seqs: { doc: number; rev: number }): Items {
  try {
    const id = free("D", new Set(docs.map((d) => d.id)));
    const doc = DOC.buildDocument(id, { title: v.title, category: v.category }, docs);
    const rev = DOC.buildRevision(`${id}-1`, id, { rev: v.rev.trim() || "As received", date: v.date ?? "", note: "" }, revs);
    return { ok: true, items: [{ recordId: `doc:${id}`, data: { kind: "tenderDoc", seq: seqs.doc, body: doc } }, { recordId: `docrev:${rev.id}`, data: { kind: "tenderDocRev", seq: seqs.rev, body: rev } }] };
  } catch (e) { return fail(e); }
}

/** A new issue of a document. It becomes the current one, and raises a flag for everything that depends on the document. */
export function newRevision(docId: string, v: { rev: string; date?: string; addendum?: string; note?: string }, revs: DocRevision[], seq: number): Items {
  try {
    const id = free(`${docId}-`, new Set(revs.map((r) => r.id)));
    const rev = DOC.buildRevision(id, docId, v, revs);
    return { ok: true, items: [{ recordId: `docrev:${id}`, data: { kind: "tenderDocRev", seq, body: rev } }] };
  } catch (e) { return fail(e); }
}

/** Say that a flagged change has been looked at. The note is required: it is what shows later why nothing was changed. */
export function clearFlags(flags: Pick<DocFlag, "key" | "revId" | "target">[], note: string, by: string, now: Date): Items {
  const n = note.trim();
  if (n.length < 3) return { ok: false, error: "Say what you checked, so the record shows why nothing needed to change." };
  if (n.length > 1000) return { ok: false, error: "That note is too long (limit 1000 characters)." };
  return {
    ok: true,
    items: flags.map((f) => ({ recordId: `docclear:${f.key}`, data: { kind: "tenderDocClear", body: { revId: f.revId, target: f.target, note: n, by, at: now.toISOString() } } })),
  };
}

/** Flags grouped by the revision that raised them, open ones first, as the window lists them. */
export function groupFlags(flags: DocFlag[]): { revId: string; docRef: string; docTitle: string; rev: string; addendum: string; revNote: string; flags: DocFlag[]; open: number }[] {
  const by = new Map<string, DocFlag[]>();
  for (const f of flags) by.set(f.revId, [...(by.get(f.revId) ?? []), f]);
  return [...by.values()]
    .map((fs) => ({ revId: fs[0]!.revId, docRef: fs[0]!.docRef, docTitle: fs[0]!.docTitle, rev: fs[0]!.rev, addendum: fs[0]!.addendum, revNote: fs[0]!.revNote, flags: fs, open: fs.filter((f) => f.open).length }))
    .sort((a, b) => Number(b.open > 0) - Number(a.open > 0));
}
