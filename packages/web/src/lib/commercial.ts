/**
 * Commercial Review edits, with no screen in them. A line is one of the CA01..CA24 commercial lines (or an allowance the estimator added,
 * CX01, CX02 ...). Each line says whether it is in the price, how it is worked out (a percentage, a fixed sum, or an engine such as Risk
 * Truth or Weather) and the number behind that. These functions say what may be changed on each line and turn what was typed into a new
 * record body, or a sentence saying what is wrong; they never let a value in that the pricing stack would refuse (a margin of 100% or
 * more would stop the whole job calculating).
 */
import { D } from "@blackline/engine";
import { isCustom, methodsFor, type RecordData } from "@blackline/tender/core";

export interface CaBody {
  ref: string;
  name: string;
  method: string;
  include: string;
  pct?: string | null;
  pcSum?: string | null;
  basis?: string;
  note?: string;
}
export interface OverlayBody { name: string; amount: string; kind?: string }

export type Edited<T> = { ok: true; body: T } | { ok: false; error: string };
export type Made = { ok: true; recordId: string; data: RecordData } | { ok: false; error: string };

const ENGINE_METHODS = ["Risk Engine", "Weather Engine", "Management Reserve"];
const PERCENT_METHODS = ["%", "Markup %", "Margin %"];
const SUM_METHODS = ["PC Sum", "Fixed Amount"];
/** Lines whose number is a plain percentage regardless of method (GST, retention, deposit); CA23 is months, not a percentage. */
const PERCENT_REFS = ["CA21", "CA22", "CA24"];

/** Whether a line's number is shown and typed as a percentage. */
export const isPercent = (l: Pick<CaBody, "ref" | "method">) => PERCENT_METHODS.includes(l.method) || PERCENT_REFS.includes(l.ref);

/** What a person may change on a line. A line fed by an engine can only be switched in or out (or onto a plain basis, where one is offered). */
export function editableFields(l: CaBody, reserveLinked: boolean) {
  const engine = ENGINE_METHODS.includes(l.method) || (l.ref === "CA16" && reserveLinked);
  return {
    include: true,
    name: true,
    method: methodsFor(l.ref).length > 1 && !(l.ref === "CA16" && reserveLinked),
    pct: !engine && (isPercent(l) || l.ref === "CA23"),
    pcSum: !engine && SUM_METHODS.includes(l.method),
  };
}

const money = (v: unknown) => String(v ?? "").trim().replace(/,/g, "").replace(/^\$+/, "");

/** A percentage as typed (10, 10%, 7.5) to the fraction the engine uses (0.1, 0.075). */
export function parsePercent(text: unknown): { ok: true; value: string } | { ok: false } {
  const s = String(text ?? "").trim().replace(/%$/, "").trim();
  if (!/^\d*\.?\d+$|^\d+\.$/.test(s)) return { ok: false };
  return { ok: true, value: new D(s.replace(/\.$/, "")).div(100).toString() };
}

/** A sum of money as typed ($1,200.50, 3000, -500) to a plain decimal string. */
export function parseSum(text: unknown, allowNegative = false): { ok: true; value: string } | { ok: false } {
  const s = money(text);
  if (!(allowNegative ? /^-?\d*\.?\d+$|^-?\d+\.$/ : /^\d*\.?\d+$|^\d+\.$/).test(s)) return { ok: false };
  return { ok: true, value: new D(s.replace(/\.$/, "")).toString() };
}

export function setCaField(body: CaBody, field: string, value: unknown, reserveLinked = false): Edited<CaBody> {
  const can = editableFields(body, reserveLinked);
  const next = { ...body };
  switch (field) {
    case "include": {
      const v = String(value ?? "").trim();
      if (v !== "Yes" && v !== "No") return { ok: false, error: "A line is either in the price (Yes) or out of it (No)." };
      next.include = v;
      break;
    }
    case "name": {
      const v = String(value ?? "").trim();
      if (!v) return { ok: false, error: "A line needs a name." };
      if (v.length > 120) return { ok: false, error: "The name is too long (limit 120 characters)." };
      next.name = v;
      break;
    }
    case "method": {
      if (!can.method) return { ok: false, error: `${body.ref} works one way only.` };
      const v = String(value ?? "").trim();
      if (!methodsFor(body.ref).includes(v)) return { ok: false, error: `${body.ref} can be worked out as: ${methodsFor(body.ref).join(", ")}.` };
      if (v === "Margin %" && new D(String(body.pct || 0)).gte(1)) return { ok: false, error: "Margin must be below 100%. Change the margin first." };
      next.method = v;
      break;
    }
    case "pct": {
      if (!can.pct) return { ok: false, error: `${body.ref} doesn't use a percentage as it is set up.` };
      if (body.ref === "CA23") {
        const r = parseSum(value);
        if (!r.ok) return { ok: false, error: "The months need a number." };
        next.pct = r.value;
        break;
      }
      const r = parsePercent(value);
      if (!r.ok) return { ok: false, error: "A percentage needs a number, for example 10 or 7.5." };
      if (body.method === "Margin %" && new D(r.value).gte(1)) return { ok: false, error: "Margin must be below 100%." };
      next.pct = r.value;
      break;
    }
    case "pcSum": {
      if (!can.pcSum) return { ok: false, error: `${body.ref} doesn't use a fixed sum as it is set up.` };
      const r = parseSum(value, true);
      if (!r.ok) return { ok: false, error: "A sum needs a number, for example 3000." };
      next.pcSum = r.value;
      break;
    }
    case "basis":
    case "note": {
      const v = String(value ?? "").trim();
      if (v.length > 500) return { ok: false, error: "That is too long (limit 500 characters)." };
      next[field] = v;
      break;
    }
    default:
      return { ok: false, error: `'${field}' can't be edited on a commercial line.` };
  }
  return { ok: true, body: next };
}

/** A new allowance line (CX01, CX02 ...): a PC sum before overhead and profit, in the price from the start. */
export function newAllowance(name: string, existingRefs: string[], seq: number): Made {
  const title = name.trim();
  if (!title) return { ok: false, error: "Name the allowance." };
  if (title.length > 120) return { ok: false, error: "The name is too long (limit 120 characters)." };
  const nums = existingRefs.filter(isCustom).map((r) => Number(/(\d+)$/.exec(r)?.[1] ?? 0));
  const ref = `CX${String(1 + Math.max(0, ...nums)).padStart(2, "0")}`;
  return { ok: true, recordId: `ca:${ref}`, data: { kind: "ca", seq, body: { ref, name: title, method: "PC Sum", include: "Yes", pct: "0", pcSum: "0", basis: "", note: "" } } };
}

/** Only an allowance somebody added can be deleted; a standard line is switched out of the price instead. */
export const canDeleteLine = (ref: string) => isCustom(ref);

/** The confirmed overlap between own works and subcontract packages. */
export function parseOverlap(text: unknown): { ok: true; value: string } | { ok: false; error: string } {
  const r = parseSum(text);
  return r.ok ? r : { ok: false, error: "The overlap needs an amount of money, for example 5000." };
}

export function setOverlayField(body: OverlayBody, field: string, value: unknown): Edited<OverlayBody> {
  const next = { ...body };
  if (field === "amount") {
    const r = parseSum(value);
    if (!r.ok) return { ok: false, error: "The amount needs a number, for example 210606." };
    next.amount = r.value;
  } else if (field === "kind") {
    const v = String(value ?? "").trim();
    if (v.length > 60) return { ok: false, error: "That is too long (limit 60 characters)." };
    next.kind = v;
  } else return { ok: false, error: `'${field}' can't be edited on a subcontract package.` };
  return { ok: true, body: next };
}

/** A new subcontract package, from its name (which must be new, since the client schedule refers to packages by name). */
export function newOverlay(name: string, existingNames: string[], seq: number): Made {
  const n = name.trim();
  if (!n) return { ok: false, error: "Name the subcontract package." };
  if (n.length > 120) return { ok: false, error: "The name is too long (limit 120 characters)." };
  if (existingNames.some((x) => x.toLowerCase() === n.toLowerCase())) return { ok: false, error: `${n} is already a subcontract package.` };
  return { ok: true, recordId: `overlay:${n}`, data: { kind: "overlay", seq, body: { name: n, amount: "0", kind: "" } } };
}
