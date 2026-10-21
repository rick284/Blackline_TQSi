/**
 * Scope register edits, with no screen in them. The rules (which owners, which treatments, how long a field may be) belong to the tender
 * package's `scope` module, the same code the server recalculates with; these functions only turn a typed value into a new record body,
 * or into a sentence saying what is wrong with it.
 */
import { scope, type RecordData } from "@blackline/tender/core";

export type ScopeBody = scope.ScopeItem;
export type Edited = { ok: true; body: ScopeBody } | { ok: false; error: string };

const failure = (e: unknown): { ok: false; error: string } => {
  if (e instanceof scope.ScopeError) return { ok: false, error: e.message };
  throw e;
};

/** One field of a scope item set to what was typed. Owner, treatment and group are matched to their lists; reference lists are tidied. */
export function setScopeField(body: ScopeBody, field: string, value: unknown): Edited {
  const next = { ...body };
  try { scope.setField(next, field, value); } catch (e) { return failure(e); }
  return { ok: true, body: next };
}

/** A reference (a QS code, register item or quote) added to one of an item's reference lists, once. */
export function addReference(body: ScopeBody, field: "cost_refs" | "register_refs" | "quote_refs", ref: string): Edited {
  const have = scope.tokens(body[field]).map((t) => t.toUpperCase());
  if (have.includes(ref.toUpperCase())) return { ok: true, body };
  return setScopeField(body, field, [...have, ref].join(", "));
}

/** The next free record id for a scope item: S1, S2 ... (a permanent id; the reference people see is separate). */
export function nextScopeId(ids: string[]): string {
  const taken = new Set(ids);
  for (let n = 1; ; n++) if (!taken.has(`S${n}`)) return `S${n}`;
}

/** A new scope item with only its requirement filled in; the reference (SC-001 ...) is the next free one. */
export function newScopeItem(title: string, existing: ScopeBody[], ids: string[], seq: number): { ok: true; recordId: string; data: RecordData } | { ok: false; error: string } {
  const id = nextScopeId(ids);
  try {
    const item = scope.buildItem(id, { title }, existing);
    return { ok: true, recordId: `scope:${id}`, data: { kind: "scope", seq, body: item } };
  } catch (e) { return failure(e); }
}
