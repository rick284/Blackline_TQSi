import { useState } from "react";
import { gantt as G } from "@blackline/tender/core";
import { CATEGORIES, ENDS, MARKERS, PALETTE, SHAPES, USUAL, categoryOf, clean, normaliseHex, resolve, type BarCategory, type BarFormat, type Resolved } from "../lib/ganttBars.js";
import { BarGlyph, Patterns } from "./GanttBarGlyph.js";

type Patch = Partial<Record<keyof BarFormat, string | undefined>>;
type Mode = "selected" | "styles";

interface Props {
  mode: Mode;
  onMode: (m: Mode) => void;
  /** The tasks selected, first one shown */
  selected: { task: G.GTask; s: G.ScheduledTask }[];
  styles: G.GProject["barStyles"];
  showCritical: boolean;
  readOnly: boolean;
  onTask: (patch: Patch) => void;
  onResetTask: () => void;
  onStyle: (cat: BarCategory, patch: Patch) => void;
  onResetStyle: (cat: BarCategory) => void;
  onClose: () => void;
}

/** A colour: the palette to click, and a box for any #rrggbb. */
function Colour({ label, value, usual, onPick, disabled }: { label: string; value: string; usual: string; onPick: (hex: string | undefined) => void; disabled: boolean }) {
  return (
    <div className="fmt-colour">
      <span className="fmt-label">{label}</span>
      <div className="swatches">
        {PALETTE.map((c) => <button key={c} className={`swatch${c === value ? " on" : ""}`} style={{ background: c }} disabled={disabled} onClick={() => onPick(c === usual ? undefined : c)} aria-label={`${label} ${c}`} title={c} />)}
        <input key={value} className="hex" defaultValue={value} disabled={disabled} aria-label={`${label} as #rrggbb`} spellCheck={false}
          onBlur={(e) => { const h = normaliseHex(e.target.value); if (!h) { e.target.value = value; return; } if (h !== value) onPick(h === usual ? undefined : h); }}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
      </div>
    </div>
  );
}

/**
 * Format Bar and Bar Styles, docked beside the chart (not a pop-up). "Selected tasks" formats just those bars; "Bar styles" formats every
 * bar of a kind (tasks, critical tasks, summaries, milestones). Whatever isn't set falls back to the project's style, then to the usual look.
 */
export function GanttFormat(p: Props) {
  const [cat, setCat] = useState<BarCategory>("task");
  const first = p.selected[0];
  const sel = p.mode === "selected";
  const kind: BarCategory = sel ? (first ? categoryOf(first.task, first.s, p.showCritical) : "task") : cat;
  const f: Resolved = sel ? (first ? resolve(first.task, first.s, p.styles, p.showCritical) : USUAL.task) : { ...USUAL[cat], ...clean(p.styles?.[cat]) };
  const usual: Resolved = sel ? { ...USUAL[kind], ...clean(p.styles?.[kind]) } : USUAL[cat];
  const off = p.readOnly || (sel && !first);
  const apply = (patch: Patch) => (sel ? p.onTask(patch) : p.onStyle(cat, patch));
  const set = (k: keyof BarFormat) => (v: string | undefined) => apply({ [k]: v });
  const sameAs = (k: keyof Resolved, v: string) => (v === usual[k] ? undefined : v);
  const isMilestone = kind === "milestone";

  return (
    <aside className="gantt-info" aria-label="Format bars">
      <h3>Format <button className="btn" style={{ marginLeft: "auto" }} onClick={p.onClose}>Close</button></h3>
      <div className="info-body">
        <div className="seg">
          <button className={sel ? "on" : ""} onClick={() => p.onMode("selected")}>Selected tasks</button>
          <button className={!sel ? "on" : ""} onClick={() => p.onMode("styles")}>Bar styles</button>
        </div>
        {sel ? (
          <p className="muted">{first ? `Formatting ${p.selected.length} selected task${p.selected.length === 1 ? "" : "s"}: ${first.task.name}${p.selected.length > 1 ? " and others" : ""}. Click a task in the table or chart first to choose.` : "Select one or more tasks in the table or chart to format their bars."}</p>
        ) : (
          <label className="fmt-row"><span className="fmt-label">Bars for</span>
            <select value={cat} onChange={(e) => setCat(e.target.value as BarCategory)} aria-label="Kind of task">
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}s</option>)}
            </select>
          </label>
        )}

        <svg className="fmt-preview" width="100%" height={40} viewBox="0 0 260 40" role="img" aria-label="Preview">
          <Patterns formats={[f]} />
          <BarGlyph f={f} x1={isMilestone ? 130 : 30} x2={isMilestone ? 130 : 230} cy={20} percent={isMilestone ? 0 : 50} kind={isMilestone ? "milestone" : kind === "summary" ? "summary" : "task"} />
        </svg>

        {!isMilestone && (
          <label className="fmt-row"><span className="fmt-label">Shape</span>
            <select value={f.shape} disabled={off} aria-label="Bar shape" onChange={(e) => apply({ shape: sameAs("shape", e.target.value) })}>
              {SHAPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </label>
        )}
        <Colour label={isMilestone ? "Fill" : "Fill"} value={f.fill} usual={usual.fill} disabled={off} onPick={set("fill")} />
        <Colour label="Border" value={f.border} usual={usual.border} disabled={off} onPick={set("border")} />
        {!isMilestone && <Colour label="Progress" value={f.progress} usual={usual.progress} disabled={off} onPick={set("progress")} />}
        {isMilestone ? (
          <label className="fmt-row"><span className="fmt-label">Marker</span>
            <select value={MARKERS.includes(f.start) ? f.start : "diamond"} disabled={off} aria-label="Milestone marker" onChange={(e) => apply({ start: sameAs("start", e.target.value) })}>
              {MARKERS.map((m) => <option key={m} value={m}>{ENDS.find((x) => x.key === m)!.label}</option>)}
            </select>
          </label>
        ) : (
          <>
            <label className="fmt-row"><span className="fmt-label">Start shape</span>
              <select value={f.start} disabled={off} aria-label="Start shape" onChange={(e) => apply({ start: sameAs("start", e.target.value) })}>{ENDS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
            </label>
            <label className="fmt-row"><span className="fmt-label">End shape</span>
              <select value={f.end} disabled={off} aria-label="End shape" onChange={(e) => apply({ end: sameAs("end", e.target.value) })}>{ENDS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
            </label>
          </>
        )}
        <div style={{ marginTop: 10 }}>
          <button className="btn" disabled={off} onClick={() => (sel ? p.onResetTask() : p.onResetStyle(cat))}>{sel ? "Back to the project's style" : "Back to the usual look"}</button>
        </div>
        <p className="muted" style={{ marginTop: 12 }}>Bar formats are saved with the plan and shown to everyone who opens it. MS Project's file has no place for them, so an export carries the dates, not the colours.</p>
      </div>
    </aside>
  );
}
