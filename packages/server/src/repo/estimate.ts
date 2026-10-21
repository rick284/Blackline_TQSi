import { D } from "@blackline/engine";
import { assembleInputs, computeTenderEstimate } from "@blackline/tender";
import type { Db } from "../db.js";
import type { Ctx } from "../errors.js";
import { jobRecords, listPackages } from "./jobs.js";

/**
 * Plain JSON for the wire: decimals become strings (exact, never floats), Maps become objects, functions drop out.
 * The client formats money for display; the number on the wire is the number the engine computed.
 */
export function jsonSafe(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (D.isDecimal(v)) return (v as { toString(): string }).toString();
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), jsonSafe(x)]));
  if (v instanceof Set) return [...v].map(jsonSafe);
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === "function") return undefined;
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).flatMap(([k, x]) => (typeof x === "function" ? [] : [[k, jsonSafe(x)]])));
  return v;
}

/**
 * Recalculate a job on the server from its checked-in records, with the same engine every client runs. Work that is checked out
 * and not yet checked in is not included: the packages list says which packages are out, so a screen can say so.
 */
export async function computeJobEstimate(db: Db, ctx: Ctx, jobId: string) {
  const records = await jobRecords(db, ctx, jobId);
  const packages = await listPackages(db, ctx, jobId);
  const estimate = computeTenderEstimate(assembleInputs(records));
  return { packages, checkedOut: packages.filter((p) => p.lock).length, estimate: jsonSafe(estimate) };
}
