/**
 * The tender letter as the client reads it, with no screen in it: what the preview shows and the print sheet prints. Only the qualifications and
 * alternatives switched on are included, and the price schedule is the one the estimate already calculated (nothing is added up here).
 */
import { money } from "./fmt.js";
import type { Alternative, Letter, Qualification } from "./submission.js";

interface ScheduleLike {
  groups: { name: string; code: string; total: { toString(): string }; lines: { ref: string; trade: string; kind: string; amount: { toString(): string } }[] }[];
  total: { toString(): string };
  reconciles: boolean;
}

export interface LetterDoc {
  company: string;
  date: string;
  addressee: string;
  attention: string;
  reference: string;
  subject: string;
  opening: string;
  closing: string;
  signatory: string;
  validity: string;
  groups: { name: string; code: string; total: string; lines: { ref: string; trade: string; amount: string; kind: string }[] }[];
  total: string;
  scheduleOk: boolean;
  alternatives: { title: string; description: string; amount: string; saving: boolean }[];
  qualifications: string[];
}

export const longDateNZ = (d: Date) => d.toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" });

export function letterDoc(o: { company: string; today: Date; letter: Letter; qualifications: Qualification[]; alternatives: Alternative[]; schedule: ScheduleLike; revision?: string }): LetterDoc {
  const { letter: l, schedule: s } = o;
  const days = Number(l.validityDays);
  const alt = (a: Alternative) => {
    const n = a.amount === "" ? 0 : Number(a.amount);
    return { title: a.title, description: a.description, amount: a.amount === "" ? "" : money(a.amount), saving: n < 0 };
  };
  return {
    company: o.company,
    date: longDateNZ(o.today),
    addressee: l.addressee, attention: l.attention, reference: l.reference, subject: l.subject, opening: l.opening, closing: l.closing, signatory: l.signatory,
    validity: days > 0 ? `This tender is valid for ${days} day${days === 1 ? "" : "s"} from the date of this letter.` : "",
    groups: s.groups.map((g) => ({ name: g.name, code: g.code, total: money(g.total), lines: g.lines.map((x) => ({ ref: x.ref, trade: x.trade, kind: x.kind, amount: money(x.amount) })) })),
    total: money(s.total),
    scheduleOk: s.reconciles,
    alternatives: o.alternatives.filter((a) => a.include).map(alt),
    qualifications: o.qualifications.filter((q) => q.include).map((q) => q.text),
  };
}
