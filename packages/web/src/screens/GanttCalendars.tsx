import { useState } from "react";
import { gantt as G } from "@blackline/tender/core";
import { formatDate } from "../lib/gantt.js";
import * as C from "../lib/ganttCalendar.js";
import type { Workspace } from "../workspace.js";

/**
 * Change Working Time: each calendar's working hours for every day of the week, and exceptions for the days that differ (public holidays, a
 * shutdown, a working Saturday). The project calendar sets when tasks can be worked; a task can have a calendar of its own (Task Information).
 * Changing a calendar reschedules the whole project at once.
 */
export function GanttCalendars({ ws, project, pkgId, editable }: { ws: Workspace; project: G.GProject; pkgId: string; editable: boolean }) {
  const [uid, setUid] = useState(project.calendarUid);
  const cal = project.calendars.find((c) => c.uid === uid) ?? project.calendars[0]!;
  const [ex, setEx] = useState({ name: "", from: "", to: "", working: false, times: "" });
  const [fresh, setFresh] = useState("");

  const warn = (text: string) => ws.notify({ kind: "warn", text });
  /** Apply an edit to the calendar being shown; a refusal is said in the page and nothing changes. */
  const edit = (fn: (c: G.GCalendar) => C.Edited<G.GCalendar> | G.GCalendar): boolean => {
    let ok = true;
    ws.edit(pkgId, `gcal:${cal.uid}`, (b: G.GCalendar) => {
      const r = fn(b);
      if ("ok" in r) { if (!r.ok) { warn(r.error); ok = false; return b; } return r.body; }
      return r;
    });
    return ok;
  };
  const config = (patch: Record<string, unknown>) => ws.edit(pkgId, "gantt:config", (b) => ({ ...b, ...patch }));
  const hours = (text: string): number | null => (/^\s*\d*\.?\d+\s*(h|hr|hrs|hours)?\s*$/i.test(text) ? Math.round(parseFloat(text) * 60) : null);
  const typical = C.typicalHours(cal);

  const dayInput = (d: number) => {
    const day = cal.week[d] ?? { working: false, times: [] };
    const shown = day.working ? C.formatTimes(day.times) : "";
    return (
      <tr key={d}>
        <th>{C.DAY_NAMES[d]}</th>
        <td>
          <input key={`${cal.uid}-${d}-${shown}`} defaultValue={shown} placeholder="Non-working" disabled={!editable} aria-label={`${C.DAY_NAMES[d]} working times`}
            onBlur={(e) => { if (e.target.value === shown) return; const r = C.parseTimes(e.target.value); if (!r.ok) { warn(r.error); e.target.value = shown; return; } edit((c) => C.setWeekDay(c, d, r.body)); }}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </td>
        <td className="r num">{day.working ? `${Math.round(C.minutesOf(day.times) / 6) / 10} hrs` : ""}</td>
      </tr>
    );
  };

  const addEx = () => {
    const times = ex.working ? C.parseTimes(ex.times) : { ok: true as const, body: [] };
    if (!times.ok) return warn(times.error);
    if (edit((c) => C.addException(c, { name: ex.name, from: ex.from, to: ex.to, working: ex.working, times: times.body }))) setEx({ name: "", from: "", to: "", working: false, times: "" });
  };

  const del = C.canDelete(project, cal.uid);
  const isProject = project.calendarUid === cal.uid;

  return (
    <div className="gantt-sheet cal-page">
      <div className="ribbon-body" style={{ minHeight: 0, padding: "6px 8px" }}>
        <div className="rrow rfields">
          <label>Calendar
            <select className="rsel" value={cal.uid} onChange={(e) => setUid(Number(e.target.value))} aria-label="Calendar">
              {project.calendars.map((c) => <option key={c.uid} value={c.uid}>{c.name}{c.uid === project.calendarUid ? " (project calendar)" : ""}</option>)}
            </select>
          </label>
          <button className="btn rbtn" disabled={!editable || isProject} onClick={() => config({ calendarUid: cal.uid })} title="Tasks without a calendar of their own work to this one">Use as the project calendar</button>
          <button className="btn rbtn" disabled={!editable || !del.ok} title={del.ok ? "" : del.why} onClick={() => { ws.removeRow(pkgId, `gcal:${cal.uid}`); setUid(project.calendarUid); }}>Delete calendar</button>
          <label>Rename <input className="find" style={{ width: 150 }} key={cal.name} defaultValue={cal.name} disabled={!editable} aria-label="Calendar name"
            onBlur={(e) => e.target.value !== cal.name && edit((c) => C.renameCalendar(c, e.target.value, project.calendars))} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} /></label>
          <label>New calendar <input className="find" style={{ width: 150 }} value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder="name (a copy of this one)" disabled={!editable} aria-label="New calendar name" /></label>
          <button className="btn rbtn" disabled={!editable || !fresh.trim()} onClick={() => {
            const r = C.newCalendar(fresh, cal, project.calendars);
            if (!r.ok) return warn(r.error);
            ws.adopt(pkgId, `gcal:${r.body.uid}`, { kind: "ganttCalendar", body: r.body });
            setFresh(""); setUid(r.body.uid);
          }}>Add</button>
        </div>
      </div>
      <div className="cal-body">
        <section>
          <h3>Working hours <span className="sub">{cal.name}</span></h3>
          <table className="plain cal-week">
            <thead><tr><th>Day</th><th>Working times (for example 08:00-12:00, 13:00-17:00; blank for non-working)</th><th className="r">Hours</th></tr></thead>
            <tbody>{C.WEEK_ORDER.map(dayInput)}</tbody>
          </table>
          <h4>Project hours</h4>
          <p className="muted">Durations are shown in days of this many hours, and "1w" means this many hours. {isProject ? "" : "These belong to the project, not to this calendar. "}</p>
          <div className="rrow rfields">
            <label>Hours per day <input className="find" style={{ width: 60 }} key={project.minutesPerDay} defaultValue={project.minutesPerDay / 60} disabled={!editable} aria-label="Hours per day"
              onBlur={(e) => { const m = hours(e.target.value); if (m === null || m < 60 || m > 1440) { warn("Hours per day is a number from 1 to 24."); e.target.value = String(project.minutesPerDay / 60); } else if (m !== project.minutesPerDay) config({ minutesPerDay: m }); }} /></label>
            <label>Hours per week <input className="find" style={{ width: 60 }} key={project.minutesPerWeek} defaultValue={project.minutesPerWeek / 60} disabled={!editable} aria-label="Hours per week"
              onBlur={(e) => { const m = hours(e.target.value); if (m === null || m < 60 || m > 10080) { warn("Hours per week is a number from 1 to 168."); e.target.value = String(project.minutesPerWeek / 60); } else if (m !== project.minutesPerWeek) config({ minutesPerWeek: m }); }} /></label>
            <button className="btn rbtn" disabled={!editable || !typical.perDay || (typical.perDay === project.minutesPerDay && typical.perWeek === project.minutesPerWeek)} onClick={() => config({ minutesPerDay: typical.perDay, minutesPerWeek: typical.perWeek })}>
              Match {cal.name} ({typical.perDay / 60} h a day, {typical.perWeek / 60} h a week)
            </button>
          </div>
        </section>
        <section>
          <h3>Exceptions <span className="sub">{cal.exceptions.length} for {cal.name}</span></h3>
          <table className="plain cal-ex">
            <thead><tr><th>Name</th><th>From</th><th>To</th><th>Working?</th><th>Working times</th><th /></tr></thead>
            <tbody>
              <tr className="new">
                <td><input value={ex.name} onChange={(e) => setEx({ ...ex, name: e.target.value })} placeholder="Labour Day" disabled={!editable} aria-label="Exception name" /></td>
                <td><input value={ex.from} onChange={(e) => setEx({ ...ex, from: e.target.value })} placeholder="26/10/26" disabled={!editable} aria-label="Exception from" /></td>
                <td><input value={ex.to} onChange={(e) => setEx({ ...ex, to: e.target.value })} placeholder="same day" disabled={!editable} aria-label="Exception to" /></td>
                <td><label><input type="checkbox" checked={ex.working} onChange={(e) => setEx({ ...ex, working: e.target.checked })} disabled={!editable} /> Working</label></td>
                <td><input value={ex.times} onChange={(e) => setEx({ ...ex, times: e.target.value })} placeholder="08:00-12:00" disabled={!editable || !ex.working} aria-label="Exception working times" /></td>
                <td><button className="btn" disabled={!editable || !ex.from.trim()} onClick={addEx}>Add</button></td>
              </tr>
              {[...cal.exceptions].map((e, i) => ({ e, i })).sort((a, b) => a.e.from.localeCompare(b.e.from)).map(({ e, i }) => (
                <tr key={`${e.from}-${i}`}>
                  <td>{e.name}</td><td>{formatDate(`${e.from}T00:00:00`)}</td><td>{e.to === e.from ? "" : formatDate(`${e.to}T00:00:00`)}</td>
                  <td>{e.working ? "Working" : "Non-working"}</td><td>{e.working ? C.formatTimes(e.times) : ""}</td>
                  <td><button className="btn" disabled={!editable} onClick={() => edit((c) => C.removeException(c, i))}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {cal.exceptions.length === 0 && <p className="muted">No exceptions. Add the public holidays and shutdowns that apply, and every task that would fall on them moves.</p>}
        </section>
      </div>
    </div>
  );
}
