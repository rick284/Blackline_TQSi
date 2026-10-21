import { COLUMNS, DEFAULT_COLUMNS, moveColumn, toggleColumn } from "../lib/ganttColumns.js";

/** Which columns the table shows and in what order, docked beside the chart (not a pop-up). The task name always stays. */
export function GanttColumns({ keys, onChange, onClose }: { keys: string[]; onChange: (keys: string[]) => void; onClose: () => void }) {
  const hidden = COLUMNS.filter((c) => !keys.includes(c.key));
  return (
    <aside className="gantt-info" aria-label="Columns">
      <h3>Columns <button className="btn" style={{ marginLeft: "auto" }} onClick={onClose}>Close</button></h3>
      <div className="info-body">
        <p className="muted" style={{ marginTop: 0 }}>Tick a column to show it. Move the ones shown up or down to change the order. Click a column heading in the table to sort by it.</p>
        <h5 className="col-h">Shown</h5>
        <ul className="col-list">
          {keys.map((k, i) => {
            const c = COLUMNS.find((x) => x.key === k)!;
            return (
              <li key={k}>
                <label><input type="checkbox" checked disabled={k === "name"} onChange={() => onChange(toggleColumn(keys, k))} /> {c.title}</label>
                <span>
                  <button className="btn" disabled={i === 0} onClick={() => onChange(moveColumn(keys, k, -1))} aria-label={`Move ${c.title} left`}>↑</button>
                  <button className="btn" disabled={i === keys.length - 1} onClick={() => onChange(moveColumn(keys, k, 1))} aria-label={`Move ${c.title} right`}>↓</button>
                </span>
              </li>
            );
          })}
        </ul>
        <h5 className="col-h">Not shown</h5>
        <ul className="col-list">
          {hidden.map((c) => <li key={c.key}><label><input type="checkbox" checked={false} onChange={() => onChange(toggleColumn(keys, c.key))} /> {c.title}</label></li>)}
        </ul>
        <button className="btn" onClick={() => onChange([...DEFAULT_COLUMNS])}>Back to the usual columns</button>
      </div>
    </aside>
  );
}
