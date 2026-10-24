import type { CustomCellEditorProps } from "ag-grid-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { num } from "../lib/fmt.js";
import { matchPicks, type Pick_ } from "../lib/rateLibrary.js";

/**
 * The resource cell of a build-up row: type to narrow the library, arrow keys and Enter (or a click) to pick. A rate from the job's own library
 * comes first; one that only the company library has is marked, and picking it copies it into the job. A code that is in neither can still be
 * typed: the row is then flagged until the rate exists.
 */
export function RateEditor(props: CustomCellEditorProps & { picks: Pick_[] }) {
  const { picks, onValueChange, stopEditing } = props;
  const [text, setText] = useState(String(props.initialValue ?? ""));
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => matchPicks(picks, text), [picks, text]);
  const active = useRef<HTMLDivElement>(null);

  // the editor opens in a popup that is attached after this first renders, so focus is taken a moment later
  const focus = () => { input.current?.focus(); input.current?.select(); };
  useEffect(() => { const t = setTimeout(focus, 30); return () => clearTimeout(t); }, []);
  useEffect(() => { active.current?.scrollIntoView({ block: "nearest" }); }, [hi, list]);

  const commit = (code: string) => { setText(code); onValueChange(code); setTimeout(() => stopEditing(), 0); };

  return (
    <div className="rate-pick" role="combobox" aria-expanded="true" aria-haspopup="listbox">
      <input
        ref={input} value={text} aria-label="Resource code" aria-autocomplete="list" placeholder="Type a code or description"
        onChange={(e) => { setText(e.target.value); setHi(0); onValueChange(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(h + 1, list.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" || e.key === "Tab") {
            // the column tells the grid to leave these keys alone while this editor is open, so the choice is made here
            e.preventDefault();
            const pick = list[hi], typed = text.trim();
            commit(pick && typed && pick.code.toLowerCase() !== typed.toLowerCase() ? pick.code : typed);
          }
        }}
      />
      <div className="list" role="listbox">
        {list.length === 0 && <div className="none">{text.trim() ? `Not in the library: ${text.trim()} will be used as typed. Use New resource to add it.` : "The library has no rates yet. Use New resource to add one."}</div>}
        {list.slice(0, 80).map((p, i) => (
          <div key={p.code} ref={i === hi ? active : undefined} role="option" aria-selected={i === hi} className={`opt${i === hi ? " on" : ""}`} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); commit(p.code); }}>
            <span className="code">{p.code}</span>
            <span className="desc">{p.description}</span>
            <span className="unit">{p.unit}</span>
            <span className="rate">{p.baseRate ? num(p.baseRate, 4) : ""}</span>
            {p.fromCompany && <span className="badge grey">Company</span>}
          </div>
        ))}
        {list.length > 80 && <div className="none">{list.length - 80} more: keep typing to narrow the list.</div>}
      </div>
    </div>
  );
}
