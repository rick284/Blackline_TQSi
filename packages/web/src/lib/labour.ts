/**
 * The labour rate builder's rules, with no screen in them. A form holds what a person typed (percentages as percentages); the engine
 * wants fractions. `preview` runs the real build-up as they type, `buildRecords` makes the two records a save writes (the library rate and
 * the build that produced it), and `canBuild` keeps the builder from overwriting a rate somebody typed in by hand.
 */
import { labourRate, type RecordData } from "@blackline/tender/core";
import { D } from "@blackline/engine";

const { EVIDENCE, computeLabourRate, labourDescription, labourLibrarySource, LabourError } = labourRate;
export { EVIDENCE };

/** What the person types: every field a string; percent fields are percentages (3 means 3%). */
export interface LabourForm {
  code: string;
  role: string;
  jurisdiction: string;
  employment_basis: string;
  source_date: string;
  evidence: string;
  source_note: string;
  reviewer: string;
  independent_check: boolean;
  hourly_rate: string;
  paid_hours_week: string;
  productive_hours_week: string;
  kiwisaver_pct: string;
  annual_leave_days: string;
  stat_days: string;
  sick_days: string;
  other_paid_days: string;
  days_per_week: string;
  levy_pct: string;
  redundancy_pct: string;
  weekly_allowance: string;
  supervision_pct: string;
}

export interface LabourBuild {
  inputs: Record<string, unknown>;
  history?: { rate: string; status: string; evidence: string; source_date: string }[];
}

const PERCENT_FIELDS = ["kiwisaver_pct", "levy_pct", "redundancy_pct", "supervision_pct"] as const;

/** A new build: the statutory minimums as suggestions (4 weeks' leave, 11 public holidays, 5 sick days, employer KiwiSaver 3%). Everything that depends on the employer is left for the person to say. */
export function newForm(today: string, code = ""): LabourForm {
  return {
    code, role: "", jurisdiction: "NZ", employment_basis: "Permanent employee", source_date: today, evidence: "market normalised", source_note: "", reviewer: "", independent_check: false,
    hourly_rate: "", paid_hours_week: "40", productive_hours_week: "", kiwisaver_pct: "3", annual_leave_days: "20", stat_days: "11", sick_days: "5", other_paid_days: "0",
    days_per_week: "5", levy_pct: "", redundancy_pct: "0", weekly_allowance: "0", supervision_pct: "0",
  };
}

const trim = (x: unknown) => { const s = String(x ?? ""); return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s; };

/** The form for a build already saved: fractions back to the percentages a person types. */
export function formFromBuild(code: string, inputs: Record<string, unknown>): LabourForm {
  const f = newForm("", code);
  for (const k of Object.keys(f) as (keyof LabourForm)[]) {
    if (k === "code") continue;
    const v = inputs[k];
    if (v === undefined || v === null) continue;
    if (k === "independent_check") f.independent_check = !!v;
    else if ((PERCENT_FIELDS as readonly string[]).includes(k)) (f as any)[k] = trim(new D(String(v)).times(100).toString());
    else (f as any)[k] = String(v);
  }
  return f;
}

/** The engine's inputs from the form: percentages become fractions; anything that isn't a number is left as typed so the engine can say so. */
export function inputsOf(f: LabourForm): Record<string, unknown> {
  const out: Record<string, unknown> = { ...f };
  delete out.code;
  for (const k of PERCENT_FIELDS) {
    const s = String(f[k] ?? "").trim().replace(/,/g, "").replace(/%$/, "");
    if (s === "") continue;
    try { const v = new D(s); out[k] = v.isFinite() ? v.div(100).toString() : s; } catch { out[k] = s; }
  }
  return out;
}

export type Preview = { ok: true; result: ReturnType<typeof computeLabourRate> } | { ok: false; error: string };

/** The live build-up for the form as it stands. */
export function preview(f: LabourForm): Preview {
  try { return { ok: true, result: computeLabourRate(inputsOf(f)) }; } catch (e) {
    if (e instanceof LabourError) return { ok: false, error: e.message };
    return { ok: false, error: "Check the numbers: each must be a plain number." };
  }
}

/** Whether a code can be built here: a new code, or a rate this builder made. A rate somebody typed into the library by hand is never overwritten. */
export function canBuild(code: string, libraryHas: boolean, hasBuild: boolean): { ok: true } | { ok: false; why: string } {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(code)) return { ok: false, why: "A code is letters, numbers, dots and dashes, up to 30 characters, for example LAB-CARP." };
  if (libraryHas && !hasBuild) return { ok: false, why: `${code} is a rate that was typed into the library. Pick a new code so it isn't overwritten.` };
  return { ok: true };
}

/**
 * The two records a save writes. The library rate is created or has its price, wording and source brought up to date (its category,
 * unit and any other columns stay as they are); the build keeps the inputs and, when it replaces an earlier build, a note of that one.
 */
export function buildRecords(code: string, f: LabourForm, previous: { library?: RecordData; build?: LabourBuild }, nextSeq: number): { library: RecordData; build: RecordData } {
  const p = preview(f);
  if (!p.ok) throw new Error(p.error);
  const r = p.result;
  const old = previous.library?.body as Record<string, unknown> | undefined;
  const library: RecordData = {
    kind: "library", seq: previous.library?.seq ?? nextSeq,
    body: {
      operatorIncluded: "", fuelIncluded: "", ...old,
      code, category: "Labour", unit: "hr", baseRate: r.rateRounded.toString(),
      description: labourDescription(r.inputs), source: labourLibrarySource(r.inputs, r.status),
    },
  };
  const history = [...(previous.build?.history ?? [])];
  if (previous.build) {
    try {
      const prior = computeLabourRate(previous.build.inputs);
      history.push({ rate: prior.rateRounded.toString(), status: prior.status, evidence: prior.inputs.evidence, source_date: prior.inputs.source_date });
    } catch { /* an old build that no longer calculates leaves no history line */ }
  }
  return { library, build: { kind: "labourBuild", seq: 0, body: { inputs: r.inputs, history } } };
}
