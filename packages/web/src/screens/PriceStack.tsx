import { money, pct } from "../lib/fmt.js";
import type { Model } from "../lib/model.js";

/** The own-works tender and the consolidated package, as the engine works them out from the records on screen. Shared by Summary and Commercial Review. */
export function PriceStack({ model }: { model: Model }) {
  const e = model.estimate;
  const t = e.tender, c = e.consolidated;
  const additions = [...t.additions].filter(([, v]) => !v.isZero());
  const names = new Map(e.commercial.map((x) => [x.ref, x.name]));
  const row = (label: string, v: { toString(): string } | null | undefined, cls = "") => (
    <tr className={cls}><td>{label}</td><td className="r num">{money(v)}</td></tr>
  );
  return (
    <>
      <h4>Own works tender</h4>
      <table className="plain">
        <tbody>
          {row("Base direct estimate", t.baseDirect)}
          {additions.map(([ref, v]) => row(`${ref}  ${names.get(ref) ?? ""}`, v, "sub"))}
          {row("Subtotal before overhead and profit", t.subtotal, "total")}
          {row("Overhead", t.overhead)}
          {row("Profit", t.profit)}
          {row("Own works tender, excluding GST", t.tenderExclGst, "total")}
          {!t.gst.isZero() && row("GST", t.gst)}
          {!t.gst.isZero() && row("Own works tender, including GST", t.tenderInclGst, "total")}
        </tbody>
      </table>
      <h4>Consolidated package</h4>
      <table className="plain">
        <tbody>
          {row("Own works, before overhead and profit", c.ownWorks)}
          {row("Subcontract packages", c.overlaysTotal)}
          {row("Less confirmed overlap", c.confirmedOverlap.negated())}
          {row("Overhead", c.overhead)}
          {row("Profit", c.profit)}
          {row("Working all-in tender, excluding GST", c.allInTender, "total")}
          {!c.confirmedOverlap.isZero() && row("All-in tender if the overlap is taken out", c.allInIfOverlapRemoved, "sub")}
          <tr><td>Gross margin on sell</td><td className="r num">{pct(c.grossMarginOnSell)}</td></tr>
        </tbody>
      </table>
    </>
  );
}
