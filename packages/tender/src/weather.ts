/**
 * Weather allowance (CA10) integration. The climate maths lives in the approved Weather Tool; this
 * reproduces the workbook's live integration of the tool outputs, scaled to the current weather-exposed
 * labour + plant pool:
 *
 *   direct productivity   = tool rain/wet-ground cost x (current exposed pool / tool-run pool)
 *   critical-path prelims = critical-path delay (WD) x daily time-related prelims
 *   billed hire           = additional billed weeks x weekly hire
 *   allowance             = productivity + prelims + hire + recovery (+ wind only if included)
 * Delay is NOT summed across concurrent tasks (the tool takes the critical path).
 */
import { type Dec, ZERO } from "@blackline/engine";
import { d, type RowResult, type WeatherInputs, type WeatherToolRun } from "./models.js";

export interface WeatherResult {
  exposedPool: Dec;
  directProductivity: Dec;
  criticalPathPrelims: Dec;
  billedHire: Dec;
  recovery: Dec;
  /** Excludes wind */
  rainWetGroundAllowance: Dec;
  /** Shown separately; added only if included */
  windSensitivity: Dec;
  /** Value feeding CA10 */
  allowance: Dec;
}

export function baselineBilledWeeks(baselineWd: Dec | number | string, wdPerWeek: Dec | number | string): number {
  const per = d(wdPerWeek);
  if (per.isZero()) return 0;
  return d(baselineWd).div(per).ceil().toNumber();
}

export function computeWeather(rows: RowResult[], tool: WeatherToolRun, inputs: WeatherInputs): WeatherResult {
  const pool = rows.reduce((t, r) => t.plus(r.weatherExposedCost), ZERO);
  const toolPool = d(tool.exposedPool);
  const scale = tool.live ? d(1) : toolPool.isZero() ? ZERO : pool.div(toolPool);
  const productivity = d(tool.rainWetGroundCost).times(scale);
  const prelims = d(tool.criticalPathDelayWd).times(d(inputs.dailyPrelims));
  const hire = d(tool.additionalBilledWeeks).times(d(inputs.weeklyHire));
  const recovery = d(inputs.recoveryAllowance);
  const rain = productivity.plus(prelims).plus(hire).plus(recovery);
  const wind = d(tool.windSensitivityCost);
  return {
    exposedPool: pool, directProductivity: productivity, criticalPathPrelims: prelims, billedHire: hire, recovery,
    rainWetGroundAllowance: rain, windSensitivity: wind, allowance: rain.plus(tool.includeWind ? wind : ZERO),
  };
}
