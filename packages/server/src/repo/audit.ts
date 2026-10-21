import type { Db } from "../db.js";

/** Append to the audit trail. It is written inside the same transaction as the change it records. */
export async function audit(
  db: Db,
  who: { orgId: string; userId: string | null },
  action: string,
  o: { jobId?: string; packageId?: string; detail?: Record<string, unknown> } = {},
): Promise<void> {
  await db.query("insert into audit_events (org_id, actor, action, job_id, package_id, detail) values ($1, $2, $3, $4, $5, $6)", [
    who.orgId, who.userId, action, o.jobId ?? null, o.packageId ?? null, JSON.stringify(o.detail ?? {}),
  ]);
}

export async function listAudit(db: Db, orgId: string, limit = 100) {
  return (await db.query("select id, at, actor, action, job_id, package_id, detail from audit_events where org_id = $1 order by id desc limit $2", [orgId, limit])).rows;
}
