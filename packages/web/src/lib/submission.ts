/**
 * Submission edits, with no screen in them: the tender letter, its qualifications and its alternatives. Each function returns a new value or says
 * what is wrong in words. What a revision freezes is whatever these hold at the moment of issue.
 */
import { D } from "@blackline/engine";
import type { submission, RecordData } from "@blackline/tender/core";

export type Letter = submission.Letter;
export type Qualification = submission.Qualification;
export type Alternative = submission.Alternative;
export type Edited<T> = { ok: true; body: T } | { ok: false; error: string };
export type Made = { ok: true; recordId: string; data: RecordData } | { ok: false; error: string };

const LIMITS: Record<keyof Letter, number> = { addressee: 200, attention: 200, reference: 100, subject: 300, opening: 3000, closing: 3000, signatory: 200, validityDays: 4 };

export function setLetterField(l: Letter, field: string, value: unknown): Edited<Letter> {
  if (!(field in LIMITS)) return { ok: false, error: `'${field}' isn't part of the tender letter.` };
  const v = String(value ?? "").trim();
  const f = field as keyof Letter;
  if (v.length > LIMITS[f]) return { ok: false, error: `That is too long (limit ${LIMITS[f]} characters).` };
  if (f === "validityDays" && !/^\d{1,3}$/.test(v)) return { ok: false, error: "Days valid is a whole number, for example 30." };
  return { ok: true, body: { ...l, [f]: v } };
}

export function setQualField(q: Qualification, field: string, value: unknown): Edited<Qualification> {
  if (field === "include") return { ok: true, body: { ...q, include: !!value } };
  if (field === "text") {
    const v = String(value ?? "").trim();
    if (!v) return { ok: false, error: "A qualification needs some words. Switch it off instead of emptying it, or delete it." };
    if (v.length > 1000) return { ok: false, error: "That is too long (limit 1000 characters)." };
    return { ok: true, body: { ...q, text: v } };
  }
  if (field === "ref") return { ok: true, body: { ...q, ref: String(value ?? "").trim().slice(0, 40) } };
  return { ok: false, error: `'${field}' can't be edited on a qualification.` };
}

const nextId = (prefix: string, ids: string[]) => { const t = new Set(ids); for (let n = 1; ; n++) if (!t.has(`${prefix}${n}`)) return `${prefix}${n}`; };

/** A qualification of your own (not from the register), at the end of the list. */
export function newQualification(text: string, ids: string[], seq: number): Made {
  const t = text.trim();
  if (!t) return { ok: false, error: "Write the qualification." };
  if (t.length > 1000) return { ok: false, error: "That is too long (limit 1000 characters)." };
  const id = nextId("Q", ids);
  const body: Qualification = { id, kind: "custom", ref: "", text: t, include: true };
  return { ok: true, recordId: `sub:q:${id}`, data: { kind: "submissionQual", seq, body } };
}

export function setAltField(a: Alternative, field: string, value: unknown): Edited<Alternative> {
  if (field === "include") return { ok: true, body: { ...a, include: !!value } };
  const v = String(value ?? "").trim();
  if (field === "title") {
    if (!v) return { ok: false, error: "An alternative needs a title." };
    if (v.length > 200) return { ok: false, error: "That is too long (limit 200 characters)." };
    return { ok: true, body: { ...a, title: v } };
  }
  if (field === "description") {
    if (v.length > 3000) return { ok: false, error: "That is too long (limit 3000 characters)." };
    return { ok: true, body: { ...a, description: v } };
  }
  if (field === "amount") {
    const s = v.replace(/,/g, "").replace(/^\$+/, "");
    if (s === "") return { ok: true, body: { ...a, amount: "" } };
    if (!/^-?\d*\.?\d+$/.test(s)) return { ok: false, error: "The amount needs a number, for example 12000 (or a negative for a saving)." };
    return { ok: true, body: { ...a, amount: new D(s).toString() } };
  }
  return { ok: false, error: `'${field}' can't be edited on an alternative.` };
}

export function newAlternative(title: string, ids: string[], seq: number): Made {
  const t = title.trim();
  if (!t) return { ok: false, error: "Name the alternative." };
  if (t.length > 200) return { ok: false, error: "That is too long (limit 200 characters)." };
  const id = nextId("A", ids);
  const body: Alternative = { id, title: t, description: "", amount: "", include: true };
  return { ok: true, recordId: `sub:alt:${id}`, data: { kind: "submissionAlt", seq, body } };
}
