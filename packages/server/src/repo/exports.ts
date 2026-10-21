import { assembleInputs, computeTenderEstimate, estimateWorkbook, letterDoc, letterPdf, submission, type RecordData } from "@blackline/tender";
import type { Db } from "../db.js";
import { type Ctx, HttpError } from "../errors.js";
import { getJob, jobRecords } from "./jobs.js";
import { revisionRecords } from "./revisions.js";

export interface FileOut { body: Buffer; type: string; name: string }

export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PDF = "application/pdf";

/** A name that is safe in a file system and in a header, and still reads as the job's. */
export const fileName = (...parts: string[]) => parts.map((p) => p.replace(/[^A-Za-z0-9 ._()-]+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean).join(" - ");

interface Source { name: string; label: string; records: { id: string; data: RecordData }[]; date: Date; subtitle: string }

async function liveSource(db: Db, ctx: Ctx, jobId: string): Promise<Source> {
  const job = await getJob(db, ctx, jobId);
  const records = await jobRecords(db, ctx, jobId);
  if (!records.length) throw new HttpError(409, "empty_job", "This job has no estimate yet, so there is nothing to export.");
  return { name: job.name, label: "working copy", records, date: new Date(), subtitle: `Working copy as checked in, ${new Date().toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })}` };
}

async function revisionSource(db: Db, ctx: Ctx, revisionId: string): Promise<Source> {
  const r = await revisionRecords(db, ctx, revisionId);
  const job = await getJob(db, ctx, r.jobId);
  const issued = new Date(r.revision.issuedAt);
  return {
    name: job.name, label: r.revision.label, records: r.records as { id: string; data: RecordData }[], date: issued,
    subtitle: `${r.revision.label}, issued ${issued.toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })} by ${r.revision.issuedBy}${r.revision.note ? `: ${r.revision.note}` : ""}`,
  };
}

async function excel(src: Source): Promise<FileOut> {
  const inputs = assembleInputs(src.records);
  const body = await estimateWorkbook(computeTenderEstimate(inputs), inputs, { title: src.name, subtitle: src.subtitle });
  return { body, type: XLSX, name: `${fileName(src.name, src.label, "estimate")}.xlsx` };
}

async function letter(db: Db, ctx: Ctx, src: Source): Promise<FileOut> {
  const s = submission.fromRecords(src.records);
  if (!s.letter) throw new HttpError(409, "no_letter", "There is no tender letter yet. Start the Submission and write the letter first.");
  const org = (await db.query<{ name: string }>("select name from organisations where id = $1", [ctx.orgId])).rows[0]?.name ?? "";
  const e = computeTenderEstimate(assembleInputs(src.records));
  const doc = letterDoc({ company: org, today: src.date, letter: s.letter, qualifications: s.qualifications, alternatives: s.alternatives, schedule: e.schedule });
  return { body: await letterPdf(doc), type: PDF, name: `${fileName(src.name, src.label, "tender letter")}.pdf` };
}

/** The job as it stands (what is checked in), or an issued revision exactly as it was sent. Anyone in the company can read these. */
export const estimateXlsx = async (db: Db, ctx: Ctx, jobId: string) => excel(await liveSource(db, ctx, jobId));
export const revisionXlsx = async (db: Db, ctx: Ctx, revisionId: string) => excel(await revisionSource(db, ctx, revisionId));
export const letterPdfOf = async (db: Db, ctx: Ctx, jobId: string) => letter(db, ctx, await liveSource(db, ctx, jobId));
export const revisionLetterPdf = async (db: Db, ctx: Ctx, revisionId: string) => letter(db, ctx, await revisionSource(db, ctx, revisionId));
