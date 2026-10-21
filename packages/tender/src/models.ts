/**
 * Tender (TQSi) engine models, ported from QSi Pro (rick284/tender-estimating-platform,
 * engine/tender_engine). Unlike QSi, the tender engine carries full precision and never
 * rounds inside the calculation chain, as the Master Estimate Workbook does. Round only
 * for presentation and reconciliation, with `cents()`.
 */
import { D, type Dec, ZERO } from "@blackline/engine";

export type Num = number | string | Dec | null | undefined;

/** Blank or missing is 0, as in a spreadsheet. */
export const d = (x: Num): Dec => (x === null || x === undefined || x === "" ? ZERO : new D(typeof x === "object" ? x.toString() : String(x)));

export const MODE_TIME = "Time x Count";
export const MODE_QTY = "QS Qty x Factor";
export const MODE_DIRECT = "Direct Qty";
export const MODE_LUMP = "Lump Sum / Quote";
export const MODES = [MODE_TIME, MODE_QTY, MODE_DIRECT, MODE_LUMP];

/** Resource Rate Library record (true direct cost, excl. GST). */
export interface LibraryRate {
  code: string;
  description?: string;
  unit?: string;
  baseRate?: Num;
  category?: string;
  operatorIncluded?: string;
  fuelIncluded?: string;
  source?: string;
}

export interface QSItem {
  code: string;
  section: string;
  description: string;
  unit: string;
  quantity: Num;
}

/** One Resource Build-Up row: inputs only, everything else is derived. */
export interface BuildUpRow {
  qsCode: string;
  mode: string;
  resourceType: string;
  resourceCode: string;
  /** QS units per hour */
  productivityRate?: Num;
  durationOverrideHrs?: Num;
  /** Resource count or factor */
  count?: Num;
  manualQty?: Num;
  /** Blank means 1 */
  utilisation?: Num;
  /** Blank means 0 */
  waste?: Num;
  /** Greater than 0 replaces the library rate */
  jobRateOverride?: Num;
  task?: string;
  verified?: string;
  weatherExposed?: string;
  weatherTaskType?: string;
  uid?: string;
}

export interface RowResult {
  rowId: string;
  qsCode: string;
  qsQty: Dec;
  calcDurationHrs: Dec | null;
  appliedDurationHrs: Dec;
  libraryRate: Dec;
  appliedRate: Dec;
  unit: string;
  cost: Dec;
  weatherExposedCost: Dec;
  qaFlag: string;
}

/** Commercial Inputs line (CA01..CA25, plus estimator-added CX lines). */
export interface CommercialInput {
  ref: string;
  name: string;
  /** Risk Engine | Weather Engine | Management Reserve | PC Sum | Fixed Amount | % | Markup % | Margin % */
  method: string;
  include: "Yes" | "No" | string;
  pct?: Num;
  pcSum?: Num;
  /** Value delivered by a linked engine (Risk Truth, Weather, Management Reserve) */
  engineValue?: Num;
}

/** Outputs recorded from an approved Weather Tool run. */
export interface WeatherToolRun {
  exposedPool: Num;
  rainWetGroundCost: Num;
  criticalPathDelayWd: Num;
  additionalBilledWeeks: Num;
  windSensitivityCost?: Num;
  includeWind?: boolean;
  /** True when the platform's own run produced the direct cost already at the live pool. */
  live?: boolean;
}

export interface WeatherInputs {
  /** Supervisor rate x hours per day */
  dailyPrelims: Num;
  /** Weekly billed hire and facilities */
  weeklyHire: Num;
  recoveryAllowance?: Num;
}

/** Subcontract or other package added once to the consolidated package. */
export interface Overlay {
  name: string;
  amount: Num;
  kind?: string;
}
