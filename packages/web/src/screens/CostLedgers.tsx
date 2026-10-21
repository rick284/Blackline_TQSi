import { useState } from "react";
import { ZERO } from "@blackline/engine";
import { costControl as K } from "@blackline/tender/core";
import { api } from "../api.js";
import { openOrders } from "../lib/costWeb.js";
import { money } from "../lib/fmt.js";
import type { CostEnv } from "./CostControl.js";

const dateText = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Orders placed (commitments) and costs incurred (invoices, labour, plant, materials): add-only, and corrected by voiding. */
export function CostLedgers({ env, mode }: { env: CostEnv; mode: "commitments" | "costs" }) {
  const { data, sum } = env;
  const [showVoided, setShowVoided] = useState(false);
  const [po, setPo] = useState({ code: "", supplier: "", ref: "", description: "", amount: "", date: env.today });
  const [ac, setAc] = useState({ code: "", kind: "invoice", supplier: "", ref: "", description: "", amount: "", hours: "", date: env.today, commitmentId: "" });
  const nameOf = new Map(env.codes.map((c) => [c.code, c.description]));
  const codeSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <select value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="">Budget line…</option>{env.codes.map((c) => <option key={c.code} value={c.code}>{c.code} {c.description}</option>)}
    </select>
  );
  const people = <datalist id="cost-people">{env.people.map((c) => <option key={c.id} value={c.name} />)}</datalist>;

  const addPo = () => env.act(async () => { await api("POST", `/jobs/${env.jobId}/cost/commitments`, po); setPo({ ...po, supplier: "", ref: "", description: "", amount: "" }); }, "Order recorded.");
  const addAc = () => env.act(async () => { await api("POST", `/jobs/${env.jobId}/cost/actuals`, { ...ac, commitmentId: ac.commitmentId || undefined }); setAc({ ...ac, supplier: "", ref: "", description: "", amount: "", hours: "", commitmentId: "" }); }, "Cost recorded.");
  const enter = (fn: () => void) => (e: { key: string }) => { if (e.key === "Enter") fn(); };

  if (mode === "commitments") {
    const result = new Map(sum.commitments.map((c) => [c.id, c]));
    const rows: (K.CommitmentResult & { voidReason: string | null })[] = data.commitments.map((c) => ({ ...(result.get(c.id) ?? { ...c, billed: ZERO, remaining: ZERO, overBilled: false }), voidReason: c.voidReason }));
    const shown = (showVoided ? rows : rows.filter((c) => !c.voided)).sort((a, b) => a.date.localeCompare(b.date));
    return (
      <section>
        <h3>Orders placed <span className="sub">{sum.commitments.length} live · ${money(sum.commitments.reduce((t, c) => t.plus(c.amount), ZERO))} ordered · ${money(sum.project.committedCost)} not yet invoiced</span>
          <label className="muted" style={{ marginLeft: "auto" }}><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} /> Show voided</label></h3>
        <div className="tablewrap">
          <table className="plain reg" style={{ minWidth: 1100 }}>
            <thead><tr><th style={{ width: 110 }}>Date</th><th style={{ width: 180 }}>Supplier</th><th style={{ width: 90 }}>Order no.</th><th style={{ width: 210 }}>Budget line</th><th>What for</th><th className="r" style={{ width: 110 }}>Ordered $</th><th className="r" style={{ width: 110 }}>Invoiced $</th><th className="r" style={{ width: 110 }}>Still on order $</th><th style={{ width: 80 }} /></tr></thead>
            <tbody>
              {env.canAdd && (
                <tr className="new">
                  <td><input type="date" value={po.date} aria-label="Order date" onChange={(e) => setPo({ ...po, date: e.target.value })} /></td>
                  <td><input list="cost-people" value={po.supplier} placeholder="Supplier" aria-label="Order supplier" onChange={(e) => setPo({ ...po, supplier: e.target.value })} />{people}</td>
                  <td><input value={po.ref} placeholder="PO-1" aria-label="Order number" onChange={(e) => setPo({ ...po, ref: e.target.value })} /></td>
                  <td>{codeSelect(po.code, (v) => setPo({ ...po, code: v }), "Order budget line")}</td>
                  <td><input value={po.description} placeholder="What it is for" aria-label="Order description" onChange={(e) => setPo({ ...po, description: e.target.value })} /></td>
                  <td><input value={po.amount} placeholder="0.00" aria-label="Order amount" style={{ textAlign: "right" }} onChange={(e) => setPo({ ...po, amount: e.target.value })} onKeyDown={enter(() => void addPo())} /></td>
                  <td colSpan={2} className="muted">Excluding GST</td>
                  <td><button className="btn" disabled={!po.code || !po.supplier.trim() || !po.amount.trim()} onClick={() => void addPo()}>Add order</button></td>
                </tr>
              )}
              {shown.map((c) => (
                <tr key={c.id} className={c.voided ? "closed" : ""} style={c.voided ? { textDecoration: "line-through" } : undefined} title={c.voided ? `Voided: ${c.voidReason ?? ""}` : undefined}>
                  <td>{dateText(c.date)}</td><td>{c.supplier}</td><td>{c.ref}</td><td>{c.code} <span className="muted">{nameOf.get(c.code)}</span></td><td>{c.description}</td>
                  <td className="r">{money(c.amount)}</td><td className="r">{c.voided || c.billed.isZero() ? "" : money(c.billed)}</td>
                  <td className={`r${c.overBilled ? " overdue" : ""}`}>{c.voided ? "" : c.overBilled ? `over by ${money(c.billed.minus(c.amount))}` : money(c.remaining)}</td>
                  <td className="acts">{env.canManage && !c.voided && <button className="btn" onClick={() => env.askVoid("commitments", c.id, `${c.supplier} ${c.ref || c.description}`.trim())}>Void</button>}</td>
                </tr>
              ))}
              {shown.length === 0 && <tr><td colSpan={9} className="muted">No orders yet.{env.canAdd ? " Add one above." : ""}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    );
  }

  const live = data.actuals.filter((a) => !a.voided);
  const shown = (showVoided ? data.actuals : live).slice().sort((a, b) => b.date.localeCompare(a.date));
  const orders = ac.code ? openOrders(data, ac.code) : [];
  return (
    <section>
      <h3>Costs incurred <span className="sub">{live.length} entr{live.length === 1 ? "y" : "ies"} · ${money(sum.project.actualCostToDate)} spent · {sum.project.actualLabourHours.toString()} labour hours</span>
        <label className="muted" style={{ marginLeft: "auto" }}><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} /> Show voided</label></h3>
      <div className="tablewrap">
        <table className="plain reg" style={{ minWidth: 1200 }}>
          <thead><tr><th style={{ width: 110 }}>Date</th><th style={{ width: 100 }}>Kind</th><th style={{ width: 160 }}>Supplier or person</th><th style={{ width: 90 }}>Reference</th><th style={{ width: 200 }}>Budget line</th><th>What for</th><th style={{ width: 70 }} className="r">Hours</th><th style={{ width: 110 }} className="r">Cost $</th><th style={{ width: 150 }}>Against order</th><th style={{ width: 80 }} /></tr></thead>
          <tbody>
            {env.canAdd && (
              <tr className="new">
                <td><input type="date" value={ac.date} aria-label="Cost date" onChange={(e) => setAc({ ...ac, date: e.target.value })} /></td>
                <td><select value={ac.kind} aria-label="Cost kind" onChange={(e) => setAc({ ...ac, kind: e.target.value })}>{K.ACTUAL_KINDS.map((k) => <option key={k} value={k}>{K.KIND_LABEL[k]}</option>)}</select></td>
                <td><input list="cost-people" value={ac.supplier} placeholder="Who" aria-label="Cost supplier" onChange={(e) => setAc({ ...ac, supplier: e.target.value })} />{people}</td>
                <td><input value={ac.ref} placeholder="Invoice no." aria-label="Cost reference" onChange={(e) => setAc({ ...ac, ref: e.target.value })} /></td>
                <td>{codeSelect(ac.code, (v) => setAc({ ...ac, code: v, commitmentId: "" }), "Cost budget line")}</td>
                <td><input value={ac.description} placeholder="What it is for" aria-label="Cost description" onChange={(e) => setAc({ ...ac, description: e.target.value })} /></td>
                <td><input value={ac.hours} placeholder="0" aria-label="Cost hours" style={{ textAlign: "right" }} onChange={(e) => setAc({ ...ac, hours: e.target.value })} /></td>
                <td><input value={ac.amount} placeholder="0.00 (credit: -0.00)" aria-label="Cost amount" style={{ textAlign: "right" }} onChange={(e) => setAc({ ...ac, amount: e.target.value })} onKeyDown={enter(() => void addAc())} /></td>
                <td><select value={ac.commitmentId} aria-label="Cost against order" disabled={orders.length === 0} onChange={(e) => setAc({ ...ac, commitmentId: e.target.value })}><option value="">{orders.length ? "No order" : "No order on this line"}</option>{orders.map((o) => <option key={o.id} value={o.id}>{o.supplier} {o.ref}</option>)}</select></td>
                <td><button className="btn" disabled={!ac.code || !ac.amount.trim()} onClick={() => void addAc()}>Add cost</button></td>
              </tr>
            )}
            {shown.map((a) => {
              const order = data.commitments.find((c) => c.id === a.commitmentId);
              return (
                <tr key={a.id} className={a.voided ? "closed" : ""} style={a.voided ? { textDecoration: "line-through" } : undefined} title={a.voided ? `Voided: ${a.voidReason ?? ""}` : undefined}>
                  <td>{dateText(a.date)}</td><td>{K.KIND_LABEL[a.kind]}</td><td>{a.supplier}</td><td>{a.ref}</td><td>{a.code} <span className="muted">{nameOf.get(a.code)}</span></td><td>{a.description}</td>
                  <td className="r">{a.hours}</td><td className="r">{money(a.amount)}</td><td className="muted">{order ? `${order.supplier} ${order.ref}` : ""}</td>
                  <td className="acts">{env.canManage && !a.voided && <button className="btn" onClick={() => env.askVoid("actuals", a.id, `${a.supplier || K.KIND_LABEL[a.kind]} ${a.ref}`.trim())}>Void</button>}</td>
                </tr>
              );
            })}
            {shown.length === 0 && <tr><td colSpan={10} className="muted">No costs yet.{env.canAdd ? " Add one above." : ""}</td></tr>}
          </tbody>
        </table>
      </div>
      {!env.canManage && <p className="muted" style={{ margin: "8px 12px" }}>A mistake is voided by a manager, with a reason.</p>}
    </section>
  );
}
