/**
 * The Gantt's data model, modelled on MS Project's so a project round-trips through MSPDI. Times are naive local date-times as text,
 * "2026-10-05T08:00:00", the way MSPDI writes them (no time zone). Durations and lags are whole working minutes.
 */

export type LinkType = "FF" | "FS" | "SF" | "SS";
export type ConstraintType = "ASAP" | "ALAP" | "MSO" | "MFO" | "SNET" | "SNLT" | "FNET" | "FNLT";
export const CONSTRAINTS: ConstraintType[] = ["ASAP", "ALAP", "MSO", "MFO", "SNET", "SNLT", "FNET", "FNLT"];
export const CONSTRAINT_NAMES: Record<ConstraintType, string> = {
  ASAP: "As Soon As Possible", ALAP: "As Late As Possible", MSO: "Must Start On", MFO: "Must Finish On",
  SNET: "Start No Earlier Than", SNLT: "Start No Later Than", FNET: "Finish No Earlier Than", FNLT: "Finish No Later Than",
};

export interface Link {
  /** UID of the predecessor task */
  uid: number;
  type: LinkType;
  /** Working minutes; negative is a lead */
  lagMin: number;
}

export interface Baseline {
  start: string;
  finish: string;
  durationMin: number;
}

/** The middle of a bar: solid, half height, outline only, hatched or dotted. */
export type BarShape = "solid" | "thin" | "outline" | "hatched" | "dotted";
/** What is drawn at the start or end of a bar (for a milestone, the start marker is its shape). */
export type EndShape = "none" | "arrow" | "triangle" | "diamond" | "circle" | "square" | "bracket";
/** How a bar looks. Any field left out takes the next level down: the task's own, then the project's style for its kind, then the usual. */
export interface BarFormat {
  shape?: BarShape;
  /** Colours as #rrggbb */
  fill?: string;
  border?: string;
  progress?: string;
  start?: EndShape;
  end?: EndShape;
}
export type BarCategory = "task" | "critical" | "summary" | "milestone";

export interface GTask {
  uid: number;
  name: string;
  /** Outline level, 1 is the top. A task is a summary when the next task is deeper. */
  outline: number;
  milestone: boolean;
  /** Working minutes (0 for a milestone). Ignored on a summary task, which rolls up its children. */
  durationMin: number;
  links: Link[];
  constraint: ConstraintType;
  constraintDate: string | null;
  deadline: string | null;
  percent: number;
  /** A calendar of its own, or null for the project's */
  calendarUid: number | null;
  notes: string;
  active: boolean;
  baseline: Baseline | null;
  /** How this task's bar looks, when it isn't the project's usual (Format Bar). Not part of an MS Project file. */
  bar?: BarFormat;
  /** The tender Programme task this one mirrors, so a change on either side carries to the other */
  progId?: string;
  /** The Programme's values for it when the two were last in step: lets a change on either side be told apart from a change on both */
  progSync?: { name: string; days: number; preds: string[] };
}

/** Minutes from midnight. */
export interface WorkTime { from: number; to: number }

export interface CalException {
  name: string;
  /** Dates, "2026-12-25", inclusive */
  from: string;
  to: string;
  working: boolean;
  /** Working times on a working exception; the weekday's own when empty */
  times: WorkTime[];
}

export interface GCalendar {
  uid: number;
  name: string;
  /** 1 = Sunday ... 7 = Saturday, as MS Project numbers them */
  week: Record<number, { working: boolean; times: WorkTime[] }>;
  exceptions: CalException[];
}

export interface GResource {
  uid: number;
  name: string;
  type: "work" | "material" | "cost";
  maxUnits: number;
  stdRate: string;
  initials: string;
}

export interface GAssignment {
  uid: number;
  taskUid: number;
  resourceUid: number;
  units: number;
}

export interface GProject {
  name: string;
  /** The project start, a date-time */
  start: string;
  statusDate: string | null;
  /** The calendar tasks use unless they have their own */
  calendarUid: number;
  /** Working minutes in a day (default 480); used to show durations in days */
  minutesPerDay: number;
  minutesPerWeek: number;
  /** The project's bar styles by kind of task (Format > Bar Styles); anything not here is the usual */
  barStyles?: Partial<Record<BarCategory, BarFormat>>;
  /** Whether the Gantt is linked to the tender Programme: a change to a linked task on either side carries to the other */
  progLink?: boolean;
  tasks: GTask[];
  calendars: GCalendar[];
  resources: GResource[];
  assignments: GAssignment[];
}

/** MS Project's "Standard" calendar: Monday to Friday, 8:00-12:00 and 13:00-17:00. */
export function standardCalendar(uid = 1, name = "Standard"): GCalendar {
  const day = [{ from: 8 * 60, to: 12 * 60 }, { from: 13 * 60, to: 17 * 60 }];
  const week: GCalendar["week"] = {};
  for (let d = 1; d <= 7; d++) week[d] = { working: d >= 2 && d <= 6, times: d >= 2 && d <= 6 ? day.map((x) => ({ ...x })) : [] };
  return { uid, name, week, exceptions: [] };
}

export function newTask(uid: number, name = "New task", outline = 1): GTask {
  return {
    uid, name, outline, milestone: false, durationMin: 480, links: [], constraint: "ASAP", constraintDate: null, deadline: null,
    percent: 0, calendarUid: null, notes: "", active: true, baseline: null,
  };
}

export function newProject(start: string, name = "Project"): GProject {
  return { name, start, statusDate: null, calendarUid: 1, minutesPerDay: 480, minutesPerWeek: 2400, tasks: [], calendars: [standardCalendar()], resources: [], assignments: [] };
}
