/**
 * Local development data, loaded only when the server starts with SEED_DEMO=1. LOCAL DEVELOPMENT ONLY: these accounts and this password
 * are public in the repository and must never exist in a deployed database.
 *
 *   Company "Demo Civil", all with password DEMO_PASSWORD (default below):
 *     owner@demo.test (owner)   maya@demo.test (manager)   carlo@demo.test, eli@demo.test (estimators)   vic@demo.test (viewer)
 *   Job "329 Hobsonville Road" imported from private/Rev34E.xlsx when that file exists, otherwise a small sample estimate.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadMasterWorkbook, splitIntoPackages, type TenderInputs } from "@blackline/tender";
import type { Db } from "./db.js";
import { registerOrganisation, addMember, sessionFor } from "./repo/accounts.js";
import { createJob, seedPackages } from "./repo/jobs.js";

export const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? "demo-password-123";

const sample: TenderInputs = {
  library: [{ code: "SUB", description: "Subcontract", unit: "ea", baseRate: "1" }],
  qs: [
    { code: "EW01", section: "Earthworks", description: "Bulk earthworks", unit: "m3", quantity: "1000" },
    { code: "PV01", section: "Pavements", description: "Basecourse", unit: "m2", quantity: "500" },
  ],
  rows: [
    { qsCode: "EW01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "10000", verified: "Yes", uid: "EW01-001" },
    { qsCode: "PV01", mode: "Lump Sum / Quote", resourceType: "Subcontract", resourceCode: "SUB", manualQty: "1", jobRateOverride: "4000", verified: "Yes", uid: "PV01-001" },
  ],
  weatherLinks: { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
  tool: { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
  commercial: [
    { ref: "CA17", name: "Overhead", method: "Markup %", include: "Yes", pct: "0.10", pcSum: "0" },
    { ref: "CA18", name: "Profit", method: "Margin %", include: "Yes", pct: "0.15", pcSum: "0" },
  ],
  overlays: [{ name: "Concrete sub", amount: "5000" }],
  overlap: "0",
  reference: null,
};

export async function seedDemo(db: Db): Promise<void> {
  // with DATA_DIR the database survives restarts, so the demo company may already be there
  if ((await db.query("select 1 from users where lower(email) = 'owner@demo.test'")).rows.length) {
    console.log("Demo data already present.");
    return;
  }
  const owner = await registerOrganisation(db, { orgName: "Demo Civil", name: "Demo Owner", email: "owner@demo.test", password: DEMO_PASSWORD });
  const ownerSession = (await sessionFor(db, owner.token))!;
  const ctx = { userId: owner.userId, orgId: owner.orgId, role: ownerSession.role };
  for (const [name, email, role] of [["Maya Manager", "maya@demo.test", "manager"], ["Carlo Estimator", "carlo@demo.test", "estimator"], ["Eli Estimator", "eli@demo.test", "estimator"], ["Vic Viewer", "vic@demo.test", "viewer"]] as const)
    await addMember(db, ctx, { name, email, password: DEMO_PASSWORD, role });

  const workbook = fileURLToPath(new URL("../../../private/Rev34E.xlsx", import.meta.url));
  const real = existsSync(workbook);
  const inputs = real ? await loadMasterWorkbook(readFileSync(workbook)) : sample;
  const job = await createJob(db, ctx, { name: real ? "329 Hobsonville Road" : "Sample job", client: real ? "TPW" : "Sample client" });
  const r = await seedPackages(db, ctx, job.id, splitIntoPackages(inputs));
  console.log(`Demo data loaded: company "Demo Civil", job "${job.name}" (${r.packages} packages, ${r.records} records). Sign in as owner@demo.test, maya@demo.test, carlo@demo.test, eli@demo.test or vic@demo.test.`);
}
