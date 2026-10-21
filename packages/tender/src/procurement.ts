/**
 * Tender procurement: asking subcontractors and suppliers to price a package, levelling the quotes that come back so they can be compared like for
 * like, and choosing one.
 *
 *   package     a piece of the work that goes out to price (Drainage). Its quotes are the quote-register entries whose `package` is this name.
 *   invite      a supplier asked to price it: when it was sent, when it is due, and whether they quoted, declined or have not answered.
 *   levelling   per quote: adjustments (add the cost of something this quote leaves out, take off something the others leave out) and every
 *               exclusion the quote states, each given a treatment (priced in the adjustments, own works, by others, accepted risk). The levelled
 *               total is the quoted amount plus the adjustments, to the cent, so quotes compare on the same scope.
 *   adjudication  one quote is selected with a reason. The platform ranks and checks; it never selects. A selected quote with an exclusion no one
 *               has dealt with holds the tender, and a difference from what the estimate carries is shown, never silently changed.
 *
 * Nothing here looks at today's date, so the same inputs give the same answer on the laptop and the server; the window shows validity.
 */
import { D, type Dec, ZERO } from "@blackline/engine";
import type { SeedPackage } from "./packaging.js";
import type { Quote } from "./quotes.js";

export const INVITE_STATUSES = ["invited", "quoted", "declined", "no-response"] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];
export const INVITE_LABEL: Record<InviteStatus, string> = { invited: "Waiting", quoted: "Quoted", declined: "Declined", "no-response": "No response" };
export const TREATMENTS = ["priced in the adjustments", "own works", "by others", "accepted risk"] as const;

export interface ProcPackage { id: string; name: string; overlay: string; scope: string; selected: string; reason: string; by: string; at: string }
export interface ProcInvite { id: string; ppId: string; supplier: string; contactId: string; sent: string; due: string; status: InviteStatus; note: string }
export interface Adjustment { label: string; amount: string }
export interface Exclusion { text: string; treatment: string; note: string }
export interface ProcLevel { quoteRef: string; adjustments: Adjustment[]; exclusions: Exclusion[]; note: string }
export interface ProcInput { packages: (ProcPackage & { seq?: number })[]; invites: (ProcInvite & { seq?: number })[]; levels: ProcLevel[] }

export class ProcurementError extends Error {}

const clip = (v: unknown, max: number, what: string) => {
  const s = String(v ?? "").trim();
  if (s.length > max) throw new ProcurementError(`${what} is too long (limit ${max} characters).`);
  return s;
};
const validDate = (s: string) => s === "" || (/^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s);
const date = (v: unknown, what: string) => {
  const s = String(v ?? "").trim();
  if (!validDate(s)) throw new ProcurementError(`${what} needs to be a real date, for example 2026-11-12.`);
  return s;
};
/** A dollar amount typed by a person, which may be negative (a saving). */
export function parseAmount(v: unknown): Dec {
  const s = String(v ?? "").trim().replace(/,/g, "").replace(/^(-?)\$+/, "$1");
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new ProcurementError("The amount needs a number, for example 2500 (or a negative for a saving).");
  return new D(s);
}

// ---- packages and invites ------------------------------------------------------------------------------------------------------------------
export function buildPackage(id: string, v: { name: unknown; overlay?: unknown; scope?: unknown }, existing: Pick<ProcPackage, "name">[]): ProcPackage {
  const name = clip(v.name, 200, "The name");
  if (!name) throw new ProcurementError("Name the package.");
  if (existing.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new ProcurementError(`${name} is already a package.`);
  return { id, name, overlay: clip(v.overlay, 200, "The subcontract package"), scope: clip(v.scope, 2000, "The scope"), selected: "", reason: "", by: "", at: "" };
}

export function setPackageField(p: ProcPackage, field: string, value: unknown): ProcPackage {
  if (field === "scope") return { ...p, scope: clip(value, 2000, "The scope") };
  if (field === "overlay") return { ...p, overlay: clip(value, 200, "The subcontract package") };
  throw new ProcurementError(`'${field}' can't be edited on a package.`);
}

export function buildInvite(id: string, ppId: string, v: { supplier: unknown; contactId?: unknown; sent?: unknown; due?: unknown; note?: unknown }): ProcInvite {
  const supplier = clip(v.supplier, 200, "The supplier");
  if (!supplier) throw new ProcurementError("Say who is being asked to price it.");
  return { id, ppId, supplier, contactId: String(v.contactId ?? ""), sent: date(v.sent, "The date sent"), due: date(v.due, "The due date"), status: "invited", note: clip(v.note, 1000, "The note") };
}

export function setInviteField(i: ProcInvite, field: string, value: unknown): ProcInvite {
  if (field === "status") {
    const s = String(value ?? "");
    if (!(INVITE_STATUSES as readonly string[]).includes(s)) throw new ProcurementError(`Status must be one of: ${INVITE_STATUSES.join(", ")}.`);
    return { ...i, status: s as InviteStatus };
  }
  if (field === "due" || field === "sent") return { ...i, [field]: date(value, field === "due" ? "The due date" : "The date sent") };
  if (field === "note") return { ...i, note: clip(value, 1000, "The note") };
  if (field === "supplier") {
    const s = clip(value, 200, "The supplier");
    if (!s) throw new ProcurementError("An invite needs a supplier.");
    return { ...i, supplier: s };
  }
  throw new ProcurementError(`'${field}' can't be edited on an invite.`);
}

// ---- levelling -----------------------------------------------------------------------------------------------------------------------------
export const blankLevel = (quoteRef: string): ProcLevel => ({ quoteRef, adjustments: [], exclusions: [], note: "" });

export function addAdjustment(l: ProcLevel, v: { label: unknown; amount: unknown }): ProcLevel {
  const label = clip(v.label, 200, "The label");
  if (!label) throw new ProcurementError("Say what the adjustment is for, for example 'Add: traffic management'.");
  const amount = parseAmount(v.amount);
  if (l.adjustments.length >= 50) throw new ProcurementError("That is plenty of adjustments for one quote: group some of them.");
  return { ...l, adjustments: [...l.adjustments, { label, amount: amount.toString() }] };
}

export const removeAdjustment = (l: ProcLevel, index: number): ProcLevel => ({ ...l, adjustments: l.adjustments.filter((_, i) => i !== index) });

export function addExclusion(l: ProcLevel, text: unknown): ProcLevel {
  const t = clip(text, 500, "The exclusion");
  if (!t) throw new ProcurementError("Write the exclusion as the quote states it.");
  if (l.exclusions.length >= 50) throw new ProcurementError("That is plenty of exclusions for one quote: group some of them.");
  return { ...l, exclusions: [...l.exclusions, { text: t, treatment: "", note: "" }] };
}

export function setExclusion(l: ProcLevel, index: number, field: string, value: unknown): ProcLevel {
  const ex = l.exclusions[index];
  if (!ex) throw new ProcurementError("That exclusion isn't there any more.");
  let next: Exclusion;
  if (field === "treatment") {
    const t = String(value ?? "");
    if (t !== "" && !(TREATMENTS as readonly string[]).includes(t)) throw new ProcurementError(`Treatment must be one of: ${TREATMENTS.join(", ")}.`);
    next = { ...ex, treatment: t };
  } else if (field === "note") next = { ...ex, note: clip(value, 500, "The note") };
  else if (field === "text") {
    const t = clip(value, 500, "The exclusion");
    if (!t) throw new ProcurementError("An exclusion needs its wording. Delete it instead of emptying it.");
    next = { ...ex, text: t };
  } else throw new ProcurementError(`'${field}' can't be edited on an exclusion.`);
  return { ...l, exclusions: l.exclusions.map((x, i) => (i === index ? next : x)) };
}

export const removeExclusion = (l: ProcLevel, index: number): ProcLevel => ({ ...l, exclusions: l.exclusions.filter((_, i) => i !== index) });

/** Select a quote with the reason, by whom and when; or clear the selection (an empty quote ref). */
export function select(p: ProcPackage, quoteRef: string, reason: string, by: string, at: string): ProcPackage {
  if (!quoteRef) return { ...p, selected: "", reason: "", by: "", at: "" };
  const r = clip(reason, 1000, "The reason");
  if (r.length < 3) throw new ProcurementError("Say why this quote is the one: the reason is kept with the tender.");
  return { ...p, selected: quoteRef, reason: r, by, at };
}

// ---- what the estimate sees ----------------------------------------------------------------------------------------------------------------
export interface Bid {
  ref: string;
  supplier: string;
  quoted: Dec;
  adjustments: Dec;
  levelled: Dec;
  amountOk: boolean;
  rank: number | null;
  lowest: boolean;
  exclusions: number;
  unresolved: number;
  validUntil: string;
  level: ProcLevel;
}
export type PackageStatus = "NO QUOTES" | "TO ADJUDICATE" | "SELECTED" | "CHECK";
export interface PackageResult extends ProcPackage {
  invites: ProcInvite[];
  inviteCounts: Record<InviteStatus, number>;
  bids: Bid[];
  selectedBid: Bid | null;
  estimate: Dec | null;
  variance: Dec | null;
  problems: string[];
  warnings: string[];
  status: PackageStatus;
}
export interface ProcResult { packages: PackageResult[]; blocking: number; toAdjudicate: number; differences: number; gate: string }

const dec = (s: string): Dec | null => {
  try { return new D(String(s).replace(/,/g, "").replace(/^\$+/, "")); } catch { return null; }
};

export function computeProcurement(input: ProcInput | null | undefined, quotes: Quote[], overlays: { name: string; amount: unknown }[]): ProcResult {
  const pkgs = [...(input?.packages ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const invites = [...(input?.invites ?? [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const levels = new Map((input?.levels ?? []).map((l) => [l.quoteRef.toUpperCase(), l]));
  const overlayAmount = new Map(overlays.map((o) => [o.name.toLowerCase(), dec(String(o.amount ?? 0))]));

  const packages: PackageResult[] = pkgs.map((p) => {
    const mine = quotes.filter((q) => q.ref && q.package.trim().toLowerCase() === p.name.toLowerCase());
    const bids: Bid[] = mine.map((q) => {
      const quoted = dec(q.amount);
      const level = levels.get(q.ref.toUpperCase()) ?? blankLevel(q.ref);
      const adj = level.adjustments.reduce((t, a) => t.plus(dec(a.amount) ?? ZERO), ZERO);
      return {
        ref: q.ref, supplier: q.supplier, quoted: quoted ?? ZERO, adjustments: adj, levelled: (quoted ?? ZERO).plus(adj), amountOk: quoted !== null && q.amount !== "",
        rank: null, lowest: false, exclusions: level.exclusions.length, unresolved: level.exclusions.filter((e) => !e.treatment).length, validUntil: q.valid_until, level,
      };
    });
    // rank like for like: lowest levelled first, equal totals share a place
    const ranked = bids.filter((b) => b.amountOk).sort((a, b) => a.levelled.cmp(b.levelled));
    let place = 0;
    ranked.forEach((b, i) => { if (i === 0 || !b.levelled.eq(ranked[i - 1]!.levelled)) place = i + 1; b.rank = place; b.lowest = place === 1; });

    const selectedBid = p.selected ? bids.find((b) => b.ref.toUpperCase() === p.selected.toUpperCase()) ?? null : null;
    const problems: string[] = [], warnings: string[] = [];
    if (p.selected && !selectedBid) problems.push(`The selected quote ${p.selected} is no longer in the quote register under ${p.name}.`);
    if (selectedBid) {
      if (!selectedBid.amountOk) problems.push(`${selectedBid.ref} has no amount.`);
      if (selectedBid.unresolved) problems.push(`${selectedBid.unresolved} exclusion${selectedBid.unresolved === 1 ? "" : "s"} in ${selectedBid.ref} ${selectedBid.unresolved === 1 ? "has" : "have"} not been dealt with.`);
      if (selectedBid.exclusions === 0) warnings.push(`No exclusions recorded for ${selectedBid.ref}. Check the quote states none.`);
    }
    const target = p.overlay ? overlayAmount.get(p.overlay.toLowerCase()) ?? null : null;
    if (p.overlay && target === null && !overlayAmount.has(p.overlay.toLowerCase())) warnings.push(`${p.overlay} isn't a subcontract package in the estimate.`);
    const variance = selectedBid && selectedBid.amountOk && target ? selectedBid.levelled.minus(target) : null;
    if (variance && variance.abs().gte("0.005")) warnings.push("The selected quote differs from what the estimate carries.");
    if (!p.selected && bids.length) warnings.push(`${bids.length} quote${bids.length === 1 ? "" : "s"} received and none selected.`);

    const status: PackageStatus = !bids.length ? "NO QUOTES" : !p.selected ? "TO ADJUDICATE" : problems.length ? "CHECK" : "SELECTED";
    const mineInvites = invites.filter((i) => i.ppId === p.id);
    const counts = Object.fromEntries(INVITE_STATUSES.map((s) => [s, mineInvites.filter((i) => i.status === s).length])) as Record<InviteStatus, number>;
    return { ...p, invites: mineInvites, inviteCounts: counts, bids, selectedBid, estimate: target, variance, problems, warnings, status };
  });

  const blocking = packages.reduce((t, p) => t + p.problems.length, 0);
  const toAdjudicate = packages.filter((p) => p.status === "TO ADJUDICATE").length;
  const differences = packages.filter((p) => p.variance && p.variance.abs().gte("0.005")).length;
  const gate = packages.length === 0 ? "NOT STARTED - no packages out for pricing"
    : blocking ? `HOLD - ${blocking} thing${blocking === 1 ? "" : "s"} to put right in selected quotes`
    : toAdjudicate ? `REVIEW - ${toAdjudicate} package${toAdjudicate === 1 ? "" : "s"} with quotes still to choose between`
    : "PASS - every package with quotes has one selected, with its exclusions dealt with";
  return { packages, blocking, toAdjudicate, differences, gate };
}

/** Where a quote's validity stands on a given day. Kept out of the estimate so a recalculation never depends on the date. */
export function validity(validUntil: string, today: string): { state: "none" | "ok" | "expired"; days: number | null } {
  if (!validUntil || !/^\d{4}-\d{2}-\d{2}/.test(validUntil)) return { state: "none", days: null };
  const days = Math.round((Date.parse(`${validUntil.slice(0, 10)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return { state: days < 0 ? "expired" : "ok", days };
}

/**
 * A job's procurement started from what it already has: one package per distinct package name in the quote register, linked to the subcontract
 * package of the same name where there is one. No invites yet; the quotes are already in.
 */
export function procurementPackage(quotes: Quote[], overlays: { name: string }[]): SeedPackage {
  const records: SeedPackage["records"] = {};
  const names: string[] = [];
  for (const q of quotes) {
    const n = q.package.trim();
    if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
  }
  names.forEach((name, i) => {
    const id = `P${i + 1}`;
    const overlay = overlays.find((o) => o.name.toLowerCase() === name.toLowerCase())?.name ?? "";
    records[`pp:${id}`] = { kind: "procPackage", seq: (i + 1) * 1000, body: { id, name, overlay, scope: "", selected: "", reason: "", by: "", at: "" } satisfies ProcPackage };
  });
  return { key: "procurement", name: "Tender Procurement", kind: "procurement", records };
}
