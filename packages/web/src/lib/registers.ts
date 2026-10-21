/**
 * Register and quote edits, with no screen in them. The rules (kinds, field limits, RFI status, the amount being a number) belong to the
 * tender package's `register` and `quotes` modules; these turn what was typed into a new record body, or a sentence saying what is wrong.
 */
import { quotes, register, type RecordData } from "@blackline/tender/core";

export type RegisterBody = register.RegisterItem;
export type QuoteBody = quotes.Quote;
export type Edited<T> = { ok: true; body: T } | { ok: false; error: string };
export type Made = { ok: true; recordId: string; data: RecordData } | { ok: false; error: string };

export const KINDS = register.KINDS;
export const RAGS = ["", "RED", "AMBER", "GREEN"];

function guard<E extends Error>(Err: new (...a: never[]) => E, fn: () => void): { ok: true } | { ok: false; error: string } {
  try { fn(); return { ok: true }; } catch (e) {
    if (e instanceof Err) return { ok: false, error: e.message };
    throw e;
  }
}

export function setRegisterField(body: RegisterBody, field: string, value: unknown): Edited<RegisterBody> {
  const next = { ...body };
  const r = guard(register.RegisterError, () => register.setField(next, field, value));
  return r.ok ? { ok: true, body: next } : r;
}

export function setQuoteField(body: QuoteBody, field: string, value: unknown): Edited<QuoteBody> {
  const next = { ...body };
  const r = guard(quotes.QuoteError, () => quotes.setField(next, field, value));
  return r.ok ? { ok: true, body: next } : r;
}

/** The next free id with a prefix: X1, X2 ... (a permanent id; the reference people see is separate). */
export function nextFree(prefix: string, ids: string[]): string {
  const taken = new Set(ids);
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** A new register item of a kind from its title; the reference (RFI-14, A10 ...) is the next free one for that kind. */
export function newRegisterItem(kind: string, title: string, existing: RegisterBody[], ids: string[], seq: number): Made {
  const id = `R-${nextFree("N", ids.map((i) => i.replace(/^R-/, "")))}`;
  try {
    const item = register.buildItem(id, { kind, title }, existing);
    return { ok: true, recordId: `register:${id}`, data: { kind: "register", seq, body: item } };
  } catch (e) {
    if (e instanceof register.RegisterError) return { ok: false, error: e.message };
    throw e;
  }
}

/** A new quote from the package it covers (or the supplier); the reference is the next free Q-nn. */
export function newQuote(packageName: string, existing: QuoteBody[], ids: string[], seq: number): Made {
  const id = nextFree("N", ids);
  try {
    const item = quotes.buildItem(id, { package: packageName }, existing);
    return { ok: true, recordId: `quote:${id}`, data: { kind: "quote", seq, body: item } };
  } catch (e) {
    if (e instanceof quotes.QuoteError) return { ok: false, error: e.message };
    throw e;
  }
}
