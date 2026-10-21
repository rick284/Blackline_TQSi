/**
 * Packaging: how a tender estimate is stored, locked and checked out.
 *
 * A tender is a set of PACKAGES, each a set of RECORDS keyed by id. A package is the unit of checkout (ARCHITECTURE.md: checkout is
 * by package). Estimate work is split so estimators can hold different parts of the same job:
 *
 *   one package per QS section   its QS items and the build-up rows that price them (Earthworks, Pavements ...)
 *   Rate Library                 library rates
 *   Commercial                   CA01-CA25 lines and the settings the stack needs (overlap, recovery, weather links, risk feed)
 *   Subcontract Packages         subcontract overlays
 *   Risk and Reserve             Risk Truth exposures and the Management Reserve block
 *   Register, Quotes and Scope   the narrative records
 *   Programme and Schedule       programme tasks and the client price schedule format
 *   Job Settings                 meta, weather tool outputs and setup, recorded reference totals
 *
 * Every record is { kind, seq?, body }. `seq` keeps list order. Money and quantities stay as decimal strings (never floats), so a
 * record round-trips through JSON exactly. `assembleInputs` rebuilds the engine's TenderInputs from any set of records, so the server
 * recalculates a job from the database with the same engine the desktop uses.
 */
import type { TenderInputs, CommercialLine } from "./estimate.js";
import type { BuildUpRow, LibraryRate, Overlay, QSItem } from "./models.js";
import type { Programme, ProgrammeTask } from "./programme.js";

export interface RecordData {
  kind: string;
  seq?: number;
  body: unknown;
}

export interface SeedPackage {
  /** Stable key within a job, e.g. "qs:Earthworks". */
  key: string;
  name: string;
  kind: "qs-section" | "library" | "commercial" | "subcontracts" | "risk" | "narrative" | "programme" | "settings" | "gantt";
  records: Record<string, RecordData>;
}

/** Decimal values serialise to strings, undefined drops out: the stored form. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const slug = (s: string) => s.trim().replace(/\s+/g, " ");

export const UNASSIGNED = "Unassigned rows";

export function splitIntoPackages(inputs: TenderInputs): SeedPackage[] {
  const out: SeedPackage[] = [];
  const put = (pkg: SeedPackage, id: string, kind: string, body: unknown, seq?: number) => {
    pkg.records[id] = { kind, ...(seq === undefined ? {} : { seq }), body: plain(body) };
  };
  const make = (key: string, name: string, kind: SeedPackage["kind"]): SeedPackage => {
    const p: SeedPackage = { key, name, kind, records: {} };
    out.push(p);
    return p;
  };

  // QS sections, in first-appearance order, with their rows
  const sections = new Map<string, SeedPackage>();
  const sectionOfCode = new Map<string, string>();
  inputs.qs.forEach((q, i) => {
    const name = slug(q.section) || "General";
    let p = sections.get(name);
    if (!p) {
      p = make(`qs:${name}`, name, "qs-section");
      sections.set(name, p);
    }
    sectionOfCode.set(q.code, name);
    put(p, `qs:${q.code}`, "qs", q, i);
  });
  inputs.rows.forEach((r, i) => {
    const name = sectionOfCode.get(r.qsCode);
    let p = name ? sections.get(name) : undefined;
    if (!p) {
      p = sections.get(UNASSIGNED) ?? make(`qs:${UNASSIGNED}`, UNASSIGNED, "qs-section");
      sections.set(UNASSIGNED, p);
    }
    put(p, `row:${r.uid ?? `${r.qsCode}-${i}`}`, "row", r, i);
  });

  const lib = make("library", "Rate Library", "library");
  inputs.library.forEach((r, i) => put(lib, `library:${r.code}`, "library", r, i));
  // a labour build lives beside the rate it produced, so one checkout covers both
  Object.entries(inputs.labourBuilds ?? {}).forEach(([code, b], i) => put(lib, `labour:${code}`, "labourBuild", b, i));

  const com = make("commercial", "Commercial", "commercial");
  inputs.commercial.forEach((c, i) => put(com, `ca:${c.ref}`, "ca", c, i));
  put(com, "setting:overlap", "setting", inputs.overlap ?? 0);
  put(com, "setting:riskFeed", "setting", inputs.riskFeed ?? {});

  const sub = make("subcontracts", "Subcontract Packages", "subcontracts");
  inputs.overlays.forEach((o, i) => put(sub, `overlay:${o.name}`, "overlay", o, i));

  const risk = make("risk", "Risk and Reserve", "risk");
  (inputs.riskTruth ?? []).forEach((e, i) => put(risk, `exposure:${e.id}`, "exposure", e, i));
  if (inputs.managementReserve) put(risk, "reserve:block", "reserve", inputs.managementReserve);

  const nar = make("narrative", "Register, Quotes and Scope", "narrative");
  (inputs.register ?? []).forEach((x, i) => put(nar, `register:${x.id}`, "register", x, i));
  (inputs.quotes ?? []).forEach((x, i) => put(nar, `quote:${x.id}`, "quote", x, i));
  (inputs.scope ?? []).forEach((x, i) => put(nar, `scope:${x.id}`, "scope", x, i));

  const prog = make("programme", "Programme and Schedule", "programme");
  if (inputs.programme) {
    const { tasks, ...config } = inputs.programme;
    put(prog, "programme:config", "programmeConfig", config);
    tasks.forEach((t, i) => put(prog, `task:${t.id}`, "task", t, i));
  }
  if (inputs.schedule) put(prog, "schedule:format", "schedule", inputs.schedule);

  const set = make("settings", "Job Settings", "settings");
  put(set, "setting:meta", "setting", inputs.meta ?? {});
  put(set, "setting:weatherLinks", "setting", inputs.weatherLinks);
  put(set, "setting:weatherMeta", "setting", inputs.weatherMeta ?? {});
  put(set, "setting:recovery", "setting", inputs.recovery ?? 0);
  put(set, "setting:tool", "setting", inputs.tool);
  if (inputs.weatherSetup) put(set, "setting:weatherSetup", "setting", inputs.weatherSetup);
  put(set, "setting:reference", "setting", inputs.reference ?? null);

  return out;
}

const bySeq = <T extends { seq?: number }>(a: T, b: T) => (a.seq ?? 0) - (b.seq ?? 0);

/** Labour builds by library code: from their own records, or (older saves) the single settings record. */
function labourBuilds(recs: { id: string; seq?: number; body: any }[] | undefined, legacy: TenderInputs["labourBuilds"]): TenderInputs["labourBuilds"] {
  if (!recs?.length) return legacy ?? undefined;
  return Object.fromEntries([...recs].sort(bySeq).map((r) => [r.id.slice("labour:".length), r.body]));
}

/** Rebuild the engine inputs from stored records (any order, any packages). */
export function assembleInputs(records: Iterable<{ id: string; data: RecordData }>): TenderInputs {
  const of = new Map<string, { id: string; seq?: number; body: any }[]>();
  const settings = new Map<string, any>();
  for (const { id, data } of records) {
    if (data.kind === "setting") settings.set(id.slice("setting:".length), data.body);
    else of.set(data.kind, [...(of.get(data.kind) ?? []), { id, seq: data.seq, body: data.body }]);
  }
  const list = <T>(kind: string): T[] => (of.get(kind) ?? []).sort(bySeq).map((r) => r.body as T);
  const one = <T>(kind: string): T | null => (of.get(kind)?.[0]?.body as T | undefined) ?? null;

  const cfg = one<Omit<Programme, "tasks">>("programmeConfig");
  const tasks = list<ProgrammeTask>("task");
  const programme: Programme | null = cfg ? { ...cfg, tasks } : null;

  const reference = settings.get("reference") ?? null;
  return {
    meta: settings.get("meta") ?? {},
    library: list<LibraryRate>("library"),
    qs: list<QSItem>("qs"),
    rows: list<BuildUpRow>("row"),
    weatherLinks: settings.get("weatherLinks") ?? { dailyUid: "", hoursPerDay: 8, weeklyUids: [] },
    weatherMeta: settings.get("weatherMeta") ?? {},
    recovery: settings.get("recovery") ?? 0,
    tool: settings.get("tool") ?? { exposedPool: 0, rainWetGroundCost: 0, criticalPathDelayWd: 0, additionalBilledWeeks: 0 },
    weatherSetup: settings.get("weatherSetup") ?? null,
    commercial: list<CommercialLine>("ca"),
    riskFeed: settings.get("riskFeed") ?? {},
    riskTruth: list("exposure"),
    register: list("register"),
    managementReserve: one("reserve"),
    overlays: list<Overlay>("overlay"),
    overlap: settings.get("overlap") ?? 0,
    schedule: one("schedule"),
    quotes: list("quote"),
    scope: list("scope"),
    programme,
    labourBuilds: labourBuilds(of.get("labourBuild"), settings.get("labourBuilds")),
    reference,
  } as TenderInputs;
}
