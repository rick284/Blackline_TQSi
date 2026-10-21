import { Fragment, useState } from "react";
import { api, ApiError } from "../api.js";
import { type ContactRow, filterContacts, KIND_LABEL, KINDS } from "../lib/enquiries.js";
import type { Env } from "./ContactsPage.js";

type Field = "name" | "kind" | "person" | "phone" | "email" | "trade" | "notes";
interface Change { id: number; at: string; by: string | null; changes: Record<string, { from: string; to: string }> }

const say = (e: unknown, f: string) => (e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : f);
const FIELD_LABEL: Record<string, string> = { name: "Name", kind: "Kind", person: "Contact person", phone: "Phone", email: "Email", trade: "Trade", notes: "Notes" };
const when = (iso: string) => new Date(iso).toLocaleString("en-NZ", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** The company's contacts: clients, consultants, subcontractors, suppliers. A contact is archived, never deleted, and every edit keeps the earlier value. */
export function ContactList({ env }: { env: Env }) {
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const [archived, setArchived] = useState(false);
  const [history, setHistory] = useState<{ id: string; items: Change[] } | null>(null);
  const [form, setForm] = useState({ name: "", kind: "client" });
  const ro = !env.canEdit;
  const rows = filterContacts(archived ? env.contacts : env.active, kind, q);

  async function save(c: ContactRow, patch: Partial<Record<Field, string>>, label: string) {
    const back: Partial<Record<Field, string>> = {};
    for (const f of Object.keys(patch) as Field[]) back[f] = c[f];
    try {
      await api("POST", `/contacts/${c.id}`, patch);
      env.push({ label: `${label} of ${c.name}`, undo: async () => { await api("POST", `/contacts/${c.id}`, back); }, redo: async () => { await api("POST", `/contacts/${c.id}`, patch); } });
      if (history?.id === c.id) void showHistory(c.id);
    } catch (e) { env.notify("warn", say(e, "That could not be saved.")); }
    await env.reload();
  }

  async function add() {
    if (!form.name.trim()) return env.notify("warn", "Give the contact a name.");
    try {
      const made = await api<ContactRow>("POST", "/contacts", { name: form.name, kind: form.kind });
      env.push({ label: `Add ${made.name}`, undo: async () => { await api("POST", `/contacts/${made.id}/archive`); }, redo: async () => { await api("POST", `/contacts/${made.id}/restore`); } });
      setForm({ name: "", kind: form.kind });
    } catch (e) { env.notify("warn", say(e, "The contact could not be added.")); }
    await env.reload();
  }

  async function archive(c: ContactRow, archive: boolean) {
    try {
      await api("POST", `/contacts/${c.id}/${archive ? "archive" : "restore"}`);
      env.push({
        label: `${archive ? "Archive" : "Restore"} ${c.name}`,
        undo: async () => { await api("POST", `/contacts/${c.id}/${archive ? "restore" : "archive"}`); },
        redo: async () => { await api("POST", `/contacts/${c.id}/${archive ? "archive" : "restore"}`); },
      });
    } catch (e) { env.notify("warn", say(e, "That could not be saved.")); }
    await env.reload();
  }

  async function showHistory(id: string) {
    try { setHistory({ id, items: await api<Change[]>("GET", `/contacts/${id}/history`) }); } catch (e) { env.notify("warn", say(e, "The history could not be loaded.")); }
  }

  const text = (c: ContactRow, f: Exclude<Field, "kind">, label: string, width?: number) => (
    <input key={c[f]} defaultValue={c[f]} disabled={ro} aria-label={`${label} of ${c.name}`} style={width ? { width } : undefined}
      onBlur={(e) => e.target.value.trim() !== c[f] && void save(c, { [f]: e.target.value }, label)} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );

  return (
    <div className="register">
      <div className="pipeline">
        {["all", ...KINDS].map((k) => {
          const n = (archived ? env.contacts : env.active).filter((c) => k === "all" || c.kind === k).length;
          return <button key={k} className={`chip${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{k === "all" ? "Everyone" : `${KIND_LABEL[k]}s`} <small>{n}</small></button>;
        })}
        <input type="search" placeholder="Search name, person, trade, phone, email" aria-label="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto", width: 280 }} />
        <label className="muted"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
      </div>
      <div className="tablewrap">
        <table className="plain reg">
          <thead>
            <tr><th style={{ width: 200 }}>Company</th><th style={{ width: 120 }}>Kind</th><th style={{ width: 150 }}>Contact person</th><th style={{ width: 120 }}>Phone</th><th style={{ width: 190 }}>Email</th>
              <th style={{ width: 150 }}>Trade</th><th>Notes</th><th className="r" style={{ width: 50 }}>Jobs</th><th style={{ width: 170 }} /></tr>
          </thead>
          <tbody>
            {env.canEdit && (
              <tr className="new">
                <td><input value={form.name} placeholder="New contact: company name" aria-label="New contact name" onChange={(e) => setForm({ ...form, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /></td>
                <td>
                  <select value={form.kind} aria-label="New contact kind" onChange={(e) => setForm({ ...form, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
                </td>
                <td colSpan={6} className="muted">Person, phone, email and notes are filled in on the line once it is added.</td>
                <td><button className="btn" disabled={!form.name.trim()} onClick={() => void add()}>Add contact</button></td>
              </tr>
            )}
            {rows.map((c) => (
              <Fragment key={c.id}>
                <tr className={c.archived_at ? "closed" : ""}>
                  <td>{text(c, "name", "Name")}</td>
                  <td>
                    <select value={c.kind} disabled={ro} aria-label={`Kind of ${c.name}`} onChange={(e) => void save(c, { kind: e.target.value }, "Kind")}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
                  </td>
                  <td>{text(c, "person", "Contact person")}</td>
                  <td>{text(c, "phone", "Phone")}</td>
                  <td>{text(c, "email", "Email")}</td>
                  <td>{text(c, "trade", "Trade")}</td>
                  <td>{text(c, "notes", "Notes")}</td>
                  <td className="r">{c.jobs || ""}</td>
                  <td className="acts">
                    <button className="btn" onClick={() => (history?.id === c.id ? setHistory(null) : void showHistory(c.id))}>{history?.id === c.id ? "Hide history" : "History"}</button>
                    {env.canEdit && <button className="btn" onClick={() => void archive(c, !c.archived_at)}>{c.archived_at ? "Restore" : "Archive"}</button>}
                  </td>
                </tr>
                {history?.id === c.id && (
                  <tr className="hist"><td colSpan={9}>
                    {history.items.length === 0 ? <span className="muted">No changes yet: this is how it was first entered.</span> : history.items.map((h) => (
                      <div key={h.id}><span className="muted">{when(h.at)} · {h.by ?? "someone"}</span>{" "}
                        {Object.entries(h.changes).map(([f, v]) => <span key={f} className="chg">{FIELD_LABEL[f] ?? f}: {v.from || "(blank)"} → {v.to || "(blank)"}</span>)}
                      </div>
                    ))}
                  </td></tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="muted">No contacts match.{env.canEdit ? " Add one above." : ""}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
