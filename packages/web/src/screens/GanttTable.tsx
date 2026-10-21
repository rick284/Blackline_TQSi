import { forwardRef, useEffect, useRef } from "react";
import { formatDate, formatDuration, formatLinks } from "../lib/gantt.js";
import { ROW_H, TIER_H } from "../lib/ganttView.js";
import type { ChartRow } from "./GanttChart.js";

export type Col = "name" | "duration" | "start" | "finish" | "pred" | "percent";
export const COLS: { key: Col | "id"; title: string; w: number }[] = [
  { key: "id", title: "ID", w: 40 },
  { key: "name", title: "Task Name", w: 250 },
  { key: "duration", title: "Duration", w: 84 },
  { key: "start", title: "Start", w: 104 },
  { key: "finish", title: "Finish", w: 104 },
  { key: "pred", title: "Predecessors", w: 116 },
  { key: "percent", title: "% Complete", w: 80 },
];
export const TABLE_W = COLS.reduce((t, c) => t + c.w, 0);

interface Props {
  rows: ChartRow[];
  selected: Set<number>;
  collapsed: Set<number>;
  editing: { uid: number; col: Col } | null;
  readOnly: boolean;
  minutesPerDay: number;
  idOf: (uid: number) => number | undefined;
  onSelect: (uid: number, mode: "one" | "toggle" | "range") => void;
  onToggle: (uid: number) => void;
  onEdit: (e: { uid: number; col: Col } | null) => void;
  /** Returns nothing; problems are said in the page by the caller */
  onCommit: (uid: number, col: Col, text: string, then: "down" | "right" | "stay", changed: boolean) => void;
  onWheel: (dy: number) => void;
}

const canEdit = (r: ChartRow, col: Col) => (col === "name" ? true : !r.s.summary);

function text(r: ChartRow, col: Col, p: Props): string {
  switch (col) {
    case "name": return r.task.name;
    case "duration": return r.task.milestone ? "0 days" : formatDuration(r.s.durationMin, p.minutesPerDay);
    case "start": return formatDate(r.s.start);
    case "finish": return formatDate(r.s.finish);
    case "pred": return formatLinks(r.task.links, p.idOf, p.minutesPerDay);
    case "percent": return `${r.s.percent}%`;
  }
}

/** What the box starts with when a cell is opened for editing: the value as it would be typed, not as it is shown. */
function editText(r: ChartRow, col: Col, p: Props): string {
  switch (col) {
    case "duration": return formatDuration(r.s.durationMin, p.minutesPerDay).replace(/ days?$/, "d").replace(/ hrs?$/, "h");
    case "start": return r.s.start.slice(0, 10);
    case "finish": return r.s.finish.slice(0, 10);
    case "percent": return String(r.s.percent);
    default: return text(r, col, p);
  }
}

/** The task table: MS Project's Entry columns, with the outline shown by indentation and a collapse arrow on each summary. */
export const GanttTable = forwardRef<HTMLDivElement, Props>(function GanttTable(p, ref) {
  return (
    <div className="gantt-table" ref={ref} style={{ width: TABLE_W }} onWheel={(e) => p.onWheel(e.deltaY)}>
      <div className="gantt-thead" style={{ height: TIER_H * 2, width: TABLE_W }}>
        {COLS.map((c) => <div key={c.key} className="gantt-th" style={{ width: c.w }}>{c.title}</div>)}
      </div>
      <div style={{ width: TABLE_W }}>
        {p.rows.map((r) => {
          const sel = p.selected.has(r.task.uid);
          return (
            <div key={r.task.uid} className={`gantt-tr${sel ? " sel" : ""}${r.s.summary ? " sum" : ""}${r.task.active ? "" : " off"}${r.s.violation ? " bad" : ""}`} style={{ height: ROW_H }}
              onClick={(e) => p.onSelect(r.task.uid, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "one")}>
              {COLS.map((c) => {
                if (c.key === "id") return <div key="id" className="gantt-td id" style={{ width: c.w }} title={r.s.violation ?? ""}>{r.s.violation ? "!" : r.s.id}</div>;
                const col = c.key as Col;
                const editing = p.editing && p.editing.uid === r.task.uid && p.editing.col === col;
                return (
                  <div key={col} className={`gantt-td ${col}${!p.readOnly && canEdit(r, col) ? " can" : ""}`} style={{ width: c.w }}
                    onDoubleClick={() => { if (!p.readOnly && canEdit(r, col)) p.onEdit({ uid: r.task.uid, col }); }}
                    onClick={() => { if (!p.readOnly && canEdit(r, col) && sel && p.selected.size === 1 && !editing) p.onEdit({ uid: r.task.uid, col }); }}>
                    {editing ? <CellBox initial={editText(r, col, p)} onCommit={(t, then, changed) => p.onCommit(r.task.uid, col, t, then, changed)} onCancel={() => p.onEdit(null)} />
                      : col === "name" ? (
                        <span style={{ paddingLeft: (r.s.level - 1) * 14 }}>
                          {r.s.summary ? <button className="twisty" aria-label={p.collapsed.has(r.task.uid) ? "Expand" : "Collapse"} onClick={(e) => { e.stopPropagation(); p.onToggle(r.task.uid); }}>{p.collapsed.has(r.task.uid) ? "▸" : "▾"}</button> : <span className="twisty-gap" />}
                          {r.task.milestone && !r.s.summary ? "◆ " : ""}{r.task.name}
                        </span>
                      ) : text(r, col, p)}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
});

function CellBox({ initial, onCommit, onCancel }: { initial: string; onCommit: (t: string, then: "down" | "right" | "stay", changed: boolean) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (then: "down" | "right" | "stay") => { if (done.current) return; done.current = true; onCommit(ref.current!.value, then, ref.current!.value !== initial); };
  return (
    <input ref={ref} className="cell-box" defaultValue={initial} aria-label="Edit cell"
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); finish("down"); }
        else if (e.key === "Tab") { e.preventDefault(); finish("right"); }
        else if (e.key === "Escape") { done.current = true; onCancel(); }
        e.stopPropagation();
      }}
      onBlur={() => finish("stay")} onClick={(e) => e.stopPropagation()} />
  );
}
