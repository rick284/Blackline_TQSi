/** The company resource library and how a job's Rate Library relates to it, with no screen in them. */
import { D } from "@blackline/engine";
import type { LibraryRow } from "./model.js";

export interface CompanyRate {
  id: string; code: string; category: string; description: string; unit: string; baseRate: string;
  operatorIncluded: string; fuelIncluded: string; source: string; updatedAt: string;
}

export const RATE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/;
export const RESOURCE_TYPES = ["Labour", "Plant", "Material", "Subcontract", "Other"];

/** A rate as the library keeps it: a plain decimal of at most 6 places. Anything that is not a number is null. */
export function cleanRate(v: unknown): string | null {
  const s = String(v ?? "").trim().replace(/,/g, "").replace(/^\$/, "");
  if (s === "") return "0";
  if (!/^\d{1,12}(\.\d+)?$/.test(s)) return null; // plain decimals only: no signs, exponents or absurd sizes
  try {
    const d = new D(s);
    return d.toDecimalPlaces(6, D.ROUND_HALF_UP).toFixed().replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  } catch { return null; }
}

/** The resource type a library rate belongs under on a build-up row: its category when that is one of the five, otherwise none. */
export function typeOfCategory(category: string): string | null {
  const c = category.trim().toLowerCase();
  return RESOURCE_TYPES.find((t) => t.toLowerCase() === c || `${t.toLowerCase()}s` === c) ?? null;
}

/** The body of a job Rate Library record for a company rate: the job takes its own copy, so a later change to the company rate never reprices it. */
export function libraryBody(r: Pick<CompanyRate, "code" | "category" | "description" | "unit" | "baseRate" | "operatorIncluded" | "fuelIncluded" | "source">) {
  return { code: r.code, category: r.category, description: r.description, unit: r.unit, baseRate: r.baseRate, operatorIncluded: r.operatorIncluded, fuelIncluded: r.fuelIncluded, source: r.source };
}

/** The company-library shape of a job's rate (for adding the job's rates to the company library). Rates that are not plain numbers are left out. */
export function toCompanyInput(r: Pick<LibraryRow, "code" | "category" | "description" | "unit" | "baseRate" | "operatorIncluded" | "fuelIncluded" | "source">) {
  const baseRate = cleanRate(r.baseRate);
  return baseRate === null ? null : { code: r.code, category: r.category, description: r.description, unit: r.unit, baseRate, operatorIncluded: r.operatorIncluded, fuelIncluded: r.fuelIncluded, source: r.source };
}

/** Rates a person can pick for a build-up row: the job's own, then the company's that the job does not have yet. */
export interface Pick_ { code: string; description: string; unit: string; baseRate: string; category: string; fromCompany: boolean }
export function pickList(job: LibraryRow[], company: CompanyRate[]): Pick_[] {
  const have = new Set(job.map((r) => r.code.toLowerCase()));
  return [
    ...job.map((r) => ({ code: r.code, description: r.description, unit: r.unit, baseRate: String(r.baseRate ?? ""), category: r.category, fromCompany: false })),
    ...company.filter((c) => !have.has(c.code.toLowerCase())).map((c) => ({ code: c.code, description: c.description, unit: c.unit, baseRate: c.baseRate, category: c.category, fromCompany: true })),
  ].sort((a, b) => a.code.localeCompare(b.code, undefined, { sensitivity: "base" }));
}

/** Narrow a pick list by what was typed into the code cell (code or description contains it; codes that start with it first). */
export function matchPicks(list: Pick_[], typed: string): Pick_[] {
  const t = typed.trim().toLowerCase();
  if (!t) return list;
  const hit = list.filter((p) => p.code.toLowerCase().includes(t) || p.description.toLowerCase().includes(t));
  return [...hit.filter((p) => p.code.toLowerCase().startsWith(t)), ...hit.filter((p) => !p.code.toLowerCase().startsWith(t))];
}
