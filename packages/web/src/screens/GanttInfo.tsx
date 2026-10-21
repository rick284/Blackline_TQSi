import { gantt as G } from "@blackline/tender/core";
import { formatDate, formatDuration, formatLinks, parseDate, parseDuration, parseLinks } from "../lib/gantt.js";

type Edit = (uid: number, fn: (t: G.GTask) => G.GTask | string) => void;

interface Props {
  task: G.GTask;
  s: G.ScheduledTask;
  project: G.GProject;
  readOnly: boolean;
  idOf: (uid: number) => number | undefined;
  uidOf: (id: number) => number | undefined;
  onEdit: Edit;
  onClose: () => void;
}

/** A box that commits when you leave it or press Enter. */
function Txt({ label, value, onCommit, disabled, wide }: { label: string; value: string; onCommit: (t: string) => void; disabled?: boolean; wide?: boolean }) {
  return (
    <label className={wide ? "wide" : ""}>
      <span>{label}</span>
      <input key={value} defaultValue={value} disabled={disabled} aria-label={label}
        onBlur={(e) => e.target.value !== value && onCommit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); e.stopPropagation(); }} />
    </label>
  );
}

/**
 * Task Information, docked beside the chart (not a pop-up): the same facts and settings as MS Project's Task Information box.
 * Every change goes through the same rules as the table, and says what is wrong in the page.
 */
export function GanttInfo({ task, s, project, readOnly, idOf, uidOf, onEdit, onClose }: Props) {
  const mpd = project.minutesPerDay;
  const timed = task.constraint !== "ASAP" && task.constraint !== "ALAP";
  return (
    <aside className="gantt-info" aria-label="Task information">
      <h3>Task Information <button className="btn" onClick={onClose} style={{ marginLeft: "auto" }}>Close</button></h3>
      <div className="info-body">
        <div className="fields">
          <h5>General</h5>
          <Txt label="Name" wide value={task.name} disabled={readOnly} onCommit={(t) => onEdit(task.uid, (x) => (t.trim() ? { ...x, name: t.trim().slice(0, 200) } : "A task needs a name."))} />
          <Txt label="Duration" value={task.milestone ? "0 days" : formatDuration(s.durationMin, mpd)} disabled={readOnly || s.summary}
            onCommit={(t) => onEdit(task.uid, (x) => { const d = parseDuration(t, mpd, project.minutesPerWeek); return d === null ? `"${t}" isn't a duration. Try 5d, 4h or 2w.` : { ...x, durationMin: d, milestone: d === 0 }; })} />
          <Txt label="% Complete" value={String(s.percent)} disabled={readOnly || s.summary}
            onCommit={(t) => onEdit(task.uid, (x) => (/^\s*\d{1,3}\s*%?\s*$/.test(t) && parseInt(t, 10) <= 100 ? { ...x, percent: parseInt(t, 10) } : "% Complete is a number from 0 to 100."))} />
          <label className="check"><input type="checkbox" checked={task.milestone} disabled={readOnly || s.summary} onChange={(e) => onEdit(task.uid, (x) => ({ ...x, milestone: e.target.checked, durationMin: e.target.checked ? 0 : x.durationMin || mpd }))} /><span>Milestone</span></label>
          <label className="check"><input type="checkbox" checked={task.active} disabled={readOnly} onChange={(e) => onEdit(task.uid, (x) => ({ ...x, active: e.target.checked }))} /><span>Active</span></label>

          <h5>Predecessors</h5>
          <Txt label="Predecessors (task, type, lag)" wide value={formatLinks(task.links, idOf, mpd)} disabled={readOnly}
            onCommit={(t) => onEdit(task.uid, (x) => { const r = parseLinks(t, uidOf, task.uid, mpd, project.minutesPerWeek); return r.ok ? { ...x, links: r.links } : r.error; })} />

          <h5>Advanced</h5>
          <label>
            <span>Constraint type</span>
            <select value={task.constraint} disabled={readOnly || s.summary} aria-label="Constraint type"
              onChange={(e) => onEdit(task.uid, (x) => { const c = e.target.value as G.ConstraintType; return { ...x, constraint: c, constraintDate: c === "ASAP" || c === "ALAP" ? null : x.constraintDate ?? s.start }; })}>
              {G.CONSTRAINTS.map((c) => <option key={c} value={c}>{G.CONSTRAINT_NAMES[c]}</option>)}
            </select>
          </label>
          <Txt label="Constraint date" value={timed ? formatDate(task.constraintDate, true) : ""} disabled={readOnly || !timed}
            onCommit={(t) => onEdit(task.uid, (x) => { const d = parseDate(t, x.constraint.startsWith("F") || x.constraint === "MFO" ? "17:00:00" : "08:00:00"); return d ? { ...x, constraintDate: d } : `"${t}" isn't a date. Try 5/10/26.`; })} />
          <Txt label="Deadline" value={formatDate(task.deadline, true)} disabled={readOnly}
            onCommit={(t) => onEdit(task.uid, (x) => { if (!t.trim()) return { ...x, deadline: null }; const d = parseDate(t, "17:00:00"); return d ? { ...x, deadline: d } : `"${t}" isn't a date. Try 5/10/26.`; })} />
          <label>
            <span>Calendar</span>
            <select value={task.calendarUid ?? ""} disabled={readOnly} aria-label="Task calendar" onChange={(e) => onEdit(task.uid, (x) => ({ ...x, calendarUid: e.target.value === "" ? null : Number(e.target.value) }))}>
              <option value="">None (project calendar)</option>
              {project.calendars.map((c) => <option key={c.uid} value={c.uid}>{c.name}</option>)}
            </select>
          </label>

          <h5>Notes</h5>
          <label className="wide">
            <textarea key={task.notes} defaultValue={task.notes} disabled={readOnly} rows={4} aria-label="Notes"
              onBlur={(e) => e.target.value !== task.notes && onEdit(task.uid, (x) => ({ ...x, notes: e.target.value.slice(0, 3000) }))} onKeyDown={(e) => e.stopPropagation()} />
          </label>
        </div>

        <table className="facts">
          <tbody>
            <tr><th>WBS</th><td>{s.wbs}</td></tr>
            <tr><th>Start</th><td>{formatDate(s.start, true)}</td></tr>
            <tr><th>Finish</th><td>{formatDate(s.finish, true)}</td></tr>
            <tr><th>Late start</th><td>{formatDate(s.lateStart, true)}</td></tr>
            <tr><th>Late finish</th><td>{formatDate(s.lateFinish, true)}</td></tr>
            <tr><th>Total slack</th><td>{formatDuration(s.totalSlackMin, mpd)}</td></tr>
            <tr><th>Free slack</th><td>{formatDuration(s.freeSlackMin, mpd)}</td></tr>
            <tr><th>Critical</th><td>{s.critical ? <span className="badge solid">Yes</span> : "No"}</td></tr>
            {task.baseline && <tr><th>Baseline</th><td>{formatDate(task.baseline.start)} to {formatDate(task.baseline.finish)}, {formatDuration(task.baseline.durationMin, mpd)}</td></tr>}
            {s.violation && <tr><th>Problem</th><td>{s.violation}</td></tr>}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
