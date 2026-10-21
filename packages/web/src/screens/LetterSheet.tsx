import type { LetterDoc } from "../lib/letterDoc.js";

/** The tender letter laid out as a page. Used for the on-screen preview and, unchanged, for printing. */
export function LetterSheet({ doc }: { doc: LetterDoc }) {
  return (
    <article className="letter-sheet">
      <header>
        <strong>{doc.company}</strong>
        <span>{doc.date}</span>
      </header>
      <p className="to">
        {doc.addressee}
        {doc.attention && <><br />Attention: {doc.attention}</>}
        {doc.reference && <><br />Your reference: {doc.reference}</>}
      </p>
      <h1>{doc.subject}</h1>
      {doc.opening.split(/\n+/).filter(Boolean).map((t, i) => <p key={i}>{t}</p>)}

      <h2>Price schedule</h2>
      <table>
        <thead><tr><th style={{ width: 80 }}>Ref</th><th>Description</th><th className="r" style={{ width: 120 }}>Amount $</th></tr></thead>
        {doc.groups.map((g) => (
          <tbody key={g.name + g.code}>
            <tr className="grp"><td colSpan={3}>{g.name}</td></tr>
            {g.lines.map((x) => <tr key={x.ref}><td>{x.ref}</td><td>{x.trade}</td><td className="r">{x.amount}</td></tr>)}
            {doc.groups.length > 1 && <tr className="sum"><td colSpan={2}>Total {g.name}</td><td className="r">{g.total}</td></tr>}
          </tbody>
        ))}
        <tfoot><tr><td colSpan={2}>Total tender price excluding GST</td><td className="r">{doc.total}</td></tr></tfoot>
      </table>

      {doc.alternatives.length > 0 && (
        <>
          <h2>Alternatives</h2>
          <table>
            <tbody>
              {doc.alternatives.map((a, i) => (
                <tr key={i}>
                  <td><strong>{a.title}</strong>{a.description && <><br />{a.description}</>}</td>
                  <td className="r" style={{ width: 140 }}>{a.amount ? `${a.saving ? "Saving " : "Add "}$${a.amount.replace("-", "")}` : "Price on request"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {doc.qualifications.length > 0 && (
        <>
          <h2>Qualifications, exclusions and assumptions</h2>
          <ol>{doc.qualifications.map((q, i) => <li key={i}>{q}</li>)}</ol>
        </>
      )}

      {doc.validity && <p>{doc.validity}</p>}
      {doc.closing.split(/\n+/).filter(Boolean).map((t, i) => <p key={i}>{t}</p>)}
      <p className="sign">{doc.signatory ? <>Yours faithfully<br /><br /><br />{doc.signatory}<br />{doc.company}</> : <>Yours faithfully<br />{doc.company}</>}</p>
    </article>
  );
}
