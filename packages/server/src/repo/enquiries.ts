import type { Db } from "../db.js";
import { type Ctx, HttpError, requireRole } from "../errors.js";
import { audit } from "./audit.js";
import { getJob, type Job } from "./jobs.js";

export interface EnquiryFields { contactId?: string | null; dueAt?: string | null; ownerId?: string | null; notes?: string; approxValue?: string }

const bad = (m: string) => new HttpError(400, "bad_request", m);

/**
 * The enquiry register fields on a job: who the client is, who owns the tender, when it is due, roughly what it is worth, and a note.
 * The client and the owner must belong to this company (the database refuses anything else; the check here gives the plain-language answer).
 */
export async function updateEnquiry(db: Db, ctx: Ctx, jobId: string, v: EnquiryFields, o: { quiet?: boolean } = {}): Promise<Job> {
  requireRole(ctx, "estimator");
  return db.tx(async (t) => {
    const was = await getJob(t, ctx, jobId);
    const sets: string[] = [], vals: unknown[] = [], changed: Record<string, unknown> = {};
    const set = (col: string, val: unknown, key: string, before: unknown) => { if (val !== before) { vals.push(val); sets.push(`${col} = $${vals.length + 2}`); changed[key] = { from: before, to: val }; } };

    if (v.contactId !== undefined) {
      if (v.contactId !== null) {
        const c = (await t.query<{ name: string; archived_at: string | null }>("select name, archived_at from contacts where id = $1 and org_id = $2", [v.contactId, ctx.orgId])).rows[0];
        if (!c) throw bad("That contact isn't in your company's contacts.");
        if (c.archived_at && v.contactId !== was.contact_id) throw bad("That contact is archived. Restore it first.");
      }
      set("contact_id", v.contactId, "contact", was.contact_id);
    }
    if (v.ownerId !== undefined) {
      if (v.ownerId !== null && !(await t.query("select 1 from memberships where org_id = $1 and user_id = $2", [ctx.orgId, v.ownerId])).rows.length) throw bad("The owner has to be someone in your company.");
      set("owner_id", v.ownerId, "owner", was.owner_id);
    }
    if (v.dueAt !== undefined) {
      let due: string | null = null;
      if (v.dueAt !== null && v.dueAt !== "") {
        if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(v.dueAt) || Number.isNaN(Date.parse(v.dueAt))) throw bad("The due date needs to be a real date, for example 2026-11-12.");
        // a deadline is a calendar date: stored as midnight UTC so every screen reads back the same date, whatever its time zone
        due = new Date(v.dueAt.length === 10 ? `${v.dueAt}T00:00:00Z` : v.dueAt).toISOString();
      }
      set("due_at", due, "due", was.due_at === null ? null : new Date(was.due_at).toISOString());
    }
    if (v.notes !== undefined) {
      const n = v.notes.trim();
      if (n.length > 2000) throw bad("The note is too long (limit 2000 characters).");
      set("notes", n, "notes", was.notes);
    }
    if (v.approxValue !== undefined) {
      const a = v.approxValue.trim().replace(/^\$/, "").replace(/,/g, "");
      if (a !== "" && !/^\d+(\.\d{1,2})?$/.test(a)) throw bad("The approximate value needs to be a dollar amount, for example 250000.");
      set("approx_value", a, "value", was.approx_value);
    }
    if (sets.length === 0) return was;
    await t.query(`update jobs set ${sets.join(", ")} where id = $1 and org_id = $2`, [jobId, ctx.orgId, ...vals]);
    if (!o.quiet) await audit(t, ctx, "enquiry.updated", { jobId, detail: changed });
    return getJob(t, ctx, jobId);
  });
}

export type Decision = "go" | "no-bid" | "lost" | "reopen";

const NEED_REASON: Decision[] = ["no-bid", "lost"];

/**
 * Go / no-go, and what happens after. It is a company decision, so it needs a manager.
 *   go      enquiry -> tendering. Hands on a registered tender, which must have an owner and a deadline.
 *   no-bid  enquiry or tendering -> no bid. The reason is required and kept: it shows which work you walk away from.
 *   lost    issued -> lost. The reason is required (why it went elsewhere).
 *   reopen  no bid or lost -> enquiry again.
 * Award is made in Contract Setup, not here.
 */
export async function decide(db: Db, ctx: Ctx, jobId: string, v: { decision: Decision; reason?: string }): Promise<Job> {
  requireRole(ctx, "manager");
  const reason = (v.reason ?? "").trim();
  if (NEED_REASON.includes(v.decision) && reason.length < 3) throw bad(v.decision === "no-bid" ? "Say why you are not bidding. The reason is kept." : "Say why the tender was lost. The reason is kept.");
  if (reason.length > 1000) throw bad("The reason is too long (limit 1000 characters).");
  return db.tx(async (t) => {
    const job = (await t.query<any>("select status, owner_id, due_at, name from jobs where id = $1 and org_id = $2 for update", [jobId, ctx.orgId])).rows[0];
    if (!job) throw new HttpError(404, "not_found", "Job not found.");
    const from: string = job.status;
    const wrong = (what: string) => new HttpError(409, "wrong_stage", `${what} (this one is ${STAGE[from] ?? from}).`);
    let to: string;
    switch (v.decision) {
      case "go":
        if (from !== "enquiry") throw wrong("Only an enquiry can be taken to tender");
        if (!job.owner_id || !job.due_at) throw new HttpError(409, "enquiry_incomplete", "Set who owns the tender and when it is due before saying go.");
        to = "tender"; break;
      case "no-bid":
        if (from !== "enquiry" && from !== "tender") throw wrong("Only an enquiry or a tender being prepared can be a no bid");
        to = "no-bid"; break;
      case "lost":
        if (from !== "issued") throw wrong("Only an issued tender can be marked lost");
        to = "lost"; break;
      case "reopen":
        if (from !== "no-bid" && from !== "lost") throw wrong("Only a no bid or a lost tender can be reopened");
        to = "enquiry"; break;
      default: throw bad("Decision must be go, no-bid, lost or reopen.");
    }
    const keep = v.decision === "no-bid" || v.decision === "lost";
    await t.query(
      "update jobs set status = $3, decision_reason = $4, decided_at = $5, decided_by = $6 where id = $1 and org_id = $2",
      [jobId, ctx.orgId, to, keep ? reason : "", keep || v.decision === "go" ? new Date().toISOString() : null, keep || v.decision === "go" ? ctx.userId : null]);
    await audit(t, ctx, `enquiry.${v.decision}`, { jobId, detail: { from, to, reason, name: job.name } });
    return getJob(t, ctx, jobId);
  });
}

const STAGE: Record<string, string> = { enquiry: "an enquiry", tender: "being tendered", issued: "issued", awarded: "awarded", lost: "lost", "no-bid": "a no bid" };
