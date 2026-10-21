/**
 * Payment schedule and retention, ported from QSi services/payments_engine.py and
 * retention_engine.py. Uses only the sell price from the pricing engine. Throws on invalid input.
 * `gstRate` is a fraction (0.15).
 */
import { cents, D, type Dec, ZERO } from "./money.js";
import { currentContractValue, type ContractVariation } from "./scenarios.js";
import type { Num, Zone } from "./types.js";

const num = (x: Num): Dec => new D(x === null || x === undefined || x === "" ? 0 : String(x));
const incGst = (ex: Dec, gstRate: Dec) => cents(ex.times(new D(1).plus(gstRate)));

// ---- retention --------------------------------------------------------------

export interface RetentionConfig {
  enabled?: boolean;
  pct?: Num;
  cap_pct?: Num;
  basis?: "stages_only" | "stages_and_final";
}

export interface Claim {
  retentionExGst: Dec;
  netExGst: Dec;
  netIncGst: Dec;
}

function applyRetention(valueEx: Dec, applies: boolean, cfg: RetentionConfig, gstRate: Dec): Claim {
  const ret = applies ? cents(valueEx.times(num(cfg.pct)).div(100)) : ZERO;
  const net = cents(valueEx.minus(ret));
  return { retentionExGst: ret, netExGst: net, netIncGst: incGst(net, gstRate) };
}

export const applyStageRetention = (valueEx: Dec, cfg: RetentionConfig, gstRate: Dec) =>
  applyRetention(valueEx, !!cfg.enabled, cfg, gstRate);

/** Final payment is only retained when the basis is "stages_and_final". */
export const applyFinalPaymentRetention = (valueEx: Dec, cfg: RetentionConfig, gstRate: Dec) =>
  applyRetention(valueEx, !!cfg.enabled && (cfg.basis ?? "stages_only") === "stages_and_final", cfg, gstRate);

export function retentionSummary(stages: { retentionExGst: Dec }[], finalRetention: Dec, cfg: RetentionConfig, contractValue: Dec, gstRate: Dec) {
  const held = stages.reduce((t, s) => t.plus(s.retentionExGst), ZERO).plus(finalRetention);
  let capExceeded = false;
  if (cfg.enabled && cfg.cap_pct !== null && cfg.cap_pct !== undefined) {
    capExceeded = held.gt(cents(contractValue.times(num(cfg.cap_pct)).div(100)));
  }
  return {
    heldExGst: cents(held),
    heldIncGst: cents(held.times(new D(1).plus(gstRate))),
    capExceeded,
  };
}

// ---- zone allocation ----------------------------------------------------------

export interface TaskAlloc {
  taskId?: string;
  taskName: string;
  directCost: Dec;
  paymentExGst: Dec;
  paymentIncGst: Dec;
}

export interface ZoneAlloc {
  zoneId?: string;
  zoneName: string;
  directCost: Dec;
  paymentExGst: Dec;
  paymentIncGst: Dec;
  tasks: TaskAlloc[];
}

/** Share the sell price across zones (then tasks) by direct cost; the last one absorbs rounding. */
export function allocateZones(zones: Zone[], sellExGst: Dec, totalIncGst: Dec, gstRate: Dec): { zones: ZoneAlloc[]; directTotal: Dec } {
  const out: ZoneAlloc[] = zones.map((z) => {
    let zdc = ZERO;
    const tasks: TaskAlloc[] = (z.tasks ?? []).map((t) => {
      let tdc = ZERO;
      for (const r of t.resources ?? []) tdc = tdc.plus(num((r.qty as Num) ?? (r as { quantity?: Num }).quantity).times(num(r.rate)));
      zdc = zdc.plus(tdc);
      return { taskId: t.id as string | undefined, taskName: (t.name as string) ?? "Unnamed Task", directCost: cents(tdc), paymentExGst: ZERO, paymentIncGst: ZERO };
    });
    return { zoneId: z.id as string | undefined, zoneName: (z.name as string) ?? "Unnamed Zone", directCost: cents(zdc), paymentExGst: ZERO, paymentIncGst: ZERO, tasks };
  });

  const directTotal = out.reduce((t, z) => t.plus(z.directCost), ZERO);
  if (directTotal.lte(0)) throw new Error("Total direct cost must be greater than zero");

  out.forEach((z, i) => {
    if (i < out.length - 1) z.paymentExGst = cents(sellExGst.times(z.directCost.div(directTotal)));
  });
  const exceptLast = out.slice(0, -1).reduce((t, z) => t.plus(z.paymentExGst), ZERO);
  out[out.length - 1]!.paymentExGst = cents(sellExGst.minus(exceptLast));

  out.forEach((z) => (z.paymentIncGst = incGst(z.paymentExGst, gstRate)));
  const incExceptLast = out.slice(0, -1).reduce((t, z) => t.plus(z.paymentIncGst), ZERO);
  out[out.length - 1]!.paymentIncGst = cents(totalIncGst.minus(incExceptLast));

  for (const z of out) {
    if (z.directCost.gt(0) && z.tasks.length) {
      z.tasks.forEach((t, j) => {
        if (j < z.tasks.length - 1) t.paymentExGst = cents(z.paymentExGst.times(t.directCost.div(z.directCost)));
      });
      const taskSum = z.tasks.slice(0, -1).reduce((t, x) => t.plus(x.paymentExGst), ZERO);
      z.tasks[z.tasks.length - 1]!.paymentExGst = cents(z.paymentExGst.minus(taskSum));
      z.tasks.forEach((t) => (t.paymentIncGst = incGst(t.paymentExGst, gstRate)));
    }
    if (z.paymentExGst.lt(0)) throw new Error(`Negative allocation for zone '${z.zoneName}'.`);
  }
  return { zones: out, directTotal: cents(directTotal) };
}

// ---- deposit, stages, final ------------------------------------------------------

export interface DepositConfig {
  type?: "none" | "percent" | "fixed";
  input_value?: Num;
}

export function computeDeposit(cfg: DepositConfig, currentCv: Dec, gstRate: Dec) {
  const input = num(cfg.input_value);
  let ex = ZERO;
  if (cfg.type === "percent") ex = cents(currentCv.times(input).div(100));
  else if (cfg.type === "fixed") ex = cents(D.min(input, currentCv));
  const remaining = cents(currentCv.minus(ex));
  if (remaining.lt(0)) throw new Error("Deposit exceeds contract value.");
  return { depositExGst: ex, depositIncGst: incGst(ex, gstRate), remainingExGst: remaining };
}

export interface StageConfig {
  id: string;
  name?: string;
  stage_order?: number;
  source?: "manual" | "zone_linked" | "task_linked";
  linked_zone_ids?: string[];
  linked_task_ids?: string[];
  manual_value_ex_gst?: Num;
}

export interface StageResult extends Claim {
  id: string;
  name: string;
  stageOrder: number;
  valueExGst: Dec;
  valueIncGst: Dec;
}

export function computeStages(
  stages: StageConfig[],
  zoneValue: (zoneId: string) => Dec,
  taskValue: (taskId: string) => Dec,
  retention: RetentionConfig,
  gstRate: Dec,
): StageResult[] {
  return [...stages]
    .sort((a, b) => (a.stage_order ?? 0) - (b.stage_order ?? 0))
    .map((s) => {
      const src = s.source ?? "manual";
      const sum = (ids: string[], f: (id: string) => Dec) => ids.reduce((t, id) => t.plus(f(id)), ZERO);
      const raw =
        src === "zone_linked" ? sum(s.linked_zone_ids ?? [], zoneValue)
        : src === "task_linked" ? sum(s.linked_task_ids ?? [], taskValue)
        : num(s.manual_value_ex_gst);
      const ex = cents(raw);
      return {
        id: s.id,
        name: s.name ?? "",
        stageOrder: s.stage_order ?? 0,
        valueExGst: ex,
        valueIncGst: incGst(ex, gstRate),
        ...applyStageRetention(ex, retention, gstRate),
      };
    });
}

/** Final payment balances the schedule. A shortfall of up to 5 cents is treated as rounding. */
export function computeFinalPayment(currentCv: Dec, depositEx: Dec, stagesEx: Dec, retention: RetentionConfig, gstRate: Dec) {
  let ex = cents(currentCv.minus(depositEx).minus(stagesEx));
  if (ex.lt(0) && ex.gte("-0.05")) ex = ZERO;
  if (ex.lt(0)) throw new Error(`Final payment is negative (${ex}). Deposit + stages exceed contract value.`);
  return { valueExGst: ex, valueIncGst: incGst(ex, gstRate), ...applyFinalPaymentRetention(ex, retention, gstRate) };
}

// ---- full schedule ----------------------------------------------------------------

export interface PaymentScheduleInput {
  zones: Zone[];
  sellExGst: Dec;
  totalIncGst: Dec;
  gstRate: Dec;
  deposit: DepositConfig;
  retention: RetentionConfig;
  stages: StageConfig[];
  variations: ContractVariation[];
}

export function buildPaymentSchedule(p: PaymentScheduleInput) {
  const { zones, directTotal } = allocateZones(p.zones, p.sellExGst, p.totalIncGst, p.gstRate);
  const cv = currentContractValue(p.sellExGst, p.variations, p.gstRate.toString());
  const currentCv = cv.currentContractValue;

  const dep = computeDeposit(p.deposit, currentCv, p.gstRate);

  // The deposit is an advance against the contract sum: stages draw from what remains.
  const pool = cents(currentCv.minus(dep.depositExGst));
  const scale = currentCv.gt(0) && dep.depositExGst.gt(0) ? pool.div(currentCv) : new D(1);
  const scaled = (v: Dec) => (scale.lt(1) ? cents(v.times(scale)) : v);

  const zoneById = new Map(zones.filter((z) => z.zoneId !== undefined).map((z) => [z.zoneId!, z]));
  const taskById = new Map(zones.flatMap((z) => z.tasks).filter((t) => t.taskId !== undefined).map((t) => [t.taskId!, t]));
  const stages = computeStages(
    p.stages,
    (id) => scaled(zoneById.get(id)?.paymentExGst ?? ZERO),
    (id) => scaled(taskById.get(id)?.paymentExGst ?? ZERO),
    p.retention,
    p.gstRate,
  );
  const stagesEx = stages.reduce((t, s) => t.plus(s.valueExGst), ZERO);

  let final = computeFinalPayment(currentCv, dep.depositExGst, stagesEx, p.retention, p.gstRate);

  // Any rounding residual goes into the final payment so the schedule reconciles exactly.
  const residual = cents(currentCv.minus(dep.depositExGst.plus(stagesEx).plus(final.valueExGst)));
  if (!residual.isZero()) {
    const ex = cents(final.valueExGst.plus(residual));
    final = { valueExGst: ex, valueIncGst: incGst(ex, p.gstRate), ...applyFinalPaymentRetention(ex, p.retention, p.gstRate) };
  }

  const reconSum = cents(dep.depositExGst.plus(stagesEx).plus(final.valueExGst));
  if (!reconSum.eq(currentCv)) throw new Error(`Schedule reconciliation failed: ${reconSum} != ${currentCv}`);

  return {
    directCostTotal: directTotal,
    zones,
    contractValue: cv,
    deposit: dep,
    remainingStagePool: pool,
    stages,
    finalPayment: final,
    retention: retentionSummary(stages, final.retentionExGst, p.retention, currentCv, p.gstRate),
    reconciliation: {
      zoneExGstMatch: cents(zones.reduce((t, z) => t.plus(z.paymentExGst), ZERO)).eq(cents(p.sellExGst)),
      zoneIncGstMatch: cents(zones.reduce((t, z) => t.plus(z.paymentIncGst), ZERO)).eq(cents(p.totalIncGst)),
      scheduleMatch: true,
    },
  };
}
