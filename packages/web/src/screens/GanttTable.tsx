import { forwardRef, useEffect, useRef } from "react";
import { canEditCell, editText, type ColDef, type Ctx, type Row, type SortSpec } from "../lib/ganttColumns.js";
import { ROW_H, TIER_H } from "../lib/ganttView.js";

interface Props {
  rows: Row[];
  columns: ColDef[];
  ctx: Ctx;
  selected: Set<number>;
  collapsed: Set<number>;
  editing: { uid: number; col: string } | null;
  sort: SortSpec | null;
  readOnly: boolean;
  onSort: (key: string) => void;
  onSelect: (uid: number, mode: "one" | "toggle" | "range") => void;
  onToggle: (uid: number) => void;
  onEdit: (e: { uid: number; col: string } | null) => void;
  onCommit: (uid: number, col: string, text: string, then: "down" | "right" | "stay", changed: boolean) => void;
  onWheel: (dy: number) => void;
}

export const tableWidth = (columns: ColDef[]) => columns.reduce((t, c) => t + c.width, 0);

/** The task table: any columns from MS Project's list, the outline shown by indentation with a collapse arrow on each summary, headings that sort. */
export const GanttTable = forwardRef<HTMLDivElement, Props>(function GanttTable(p, ref) {
  const W = tableWidth(p.columns);
  return (
    <div className="gantt-table" ref={ref} style={{ width: W }} onWheel={(e) => p.onWheel(e.deltaY)}>
      <div className="gantt-thead" style={{ height: TIER_H * 2, width: W }}>
        {p.columns.map((c) => (
          <button key={c.key} className="gantt-th" style={{ width: c.width, justifyContent: c.align === "right" ? "flex-end" : c.align === "center" ? "center" : "flex-start" }} onClick={() => p.onSort(c.key)} title={`Sort by ${c.title}`}>
            {c.title}{p.sort?.key === c.key ? (p.sort.dir === "asc" ? " ▲" : " ▼") : ""}
          </button>
        ))}
      </div>
      <div style={{ width: W }}>
        {p.rows.map((r) => {
          const sel = p.selected.has(r.task.uid);
          return (
            <div key={r.task.uid} className={`gantt-tr${sel ? " sel" : ""}${r.s.summary ? " sum" : ""}${r.task.active ? "" : " off"}${r.s.violation ? " bad" : ""}`} style={{ height: ROW_H }}
              onClick={(e) => p.onSelect(r.task.uid, e.ctrlKey || e.metaKey ? "toggle" : e.shiftKey ? "range" : "one")}>
              {p.columns.map((c) => {
                const editing = p.editing && p.editing.uid === r.task.uid && p.editing.col === c.key;
                const can = !p.readOnly && canEditCell(c.key, r);
                const align = c.align === "right" ? " r" : c.align === "center" ? " c" : "";
                if (c.key === "id") return <div key="id" className="gantt-td id" style={{ width: c.width }} title={r.s.violation ?? ""}>{r.s.violation ? "!" : r.s.id}</div>;
                return (
                  <div key={c.key} className={`gantt-td${align}${can ? " can" : ""}`} style={{ width: c.width }}
                    onDoubleClick={() => { if (can) p.onEdit({ uid: r.task.uid, col: c.key }); }}
                    onClick={() => { if (can && sel && p.selected.size === 1 && !editing) p.onEdit({ uid: r.task.uid, col: c.key }); }}>
                    {editing ? <CellBox initial={editText(c.key, r, p.ctx)} onCommit={(t, then, changed) => p.onCommit(r.task.uid, c.key, t, then, changed)} onCancel={() => p.onEdit(null)} />
                      : c.key === "name" ? (
                        <span style={{ paddingLeft: (r.s.level - 1) * 14 }}>
                          {r.s.summary ? <button className="twisty" aria-label={p.collapsed.has(r.task.uid) ? "Expand" : "Collapse"} onClick={(e) => { e.stopPropagation(); p.onToggle(r.task.uid); }}>{p.collapsed.has(r.task.uid) ? "▸" : "▾"}</button> : <span className="twisty-gap" />}
                          {r.task.milestone && !r.s.summary ? "◆ " : ""}{r.task.name}
                        </span>
                      ) : c.text(r, p.ctx)}
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
