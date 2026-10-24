import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { type Action, type ActionHistory, none, record, stepBack, stepForward } from "../lib/actionHistory.js";
import type { ContactRow, EnquiryJob } from "../lib/enquiries.js";
import { type ContactsTab, hrefJobs } from "../route.js";
import { useSession } from "../session.js";
import { CompanyNav } from "./CompanyNav.js";
import { ContactList } from "./ContactList.js";
import { EnquiryRegister } from "./EnquiryRegister.js";
import { Shell } from "./Shell.js";

export interface Member { user_id: string; name: string; role: string }
export interface Env {
  jobs: EnquiryJob[];
  contacts: ContactRow[];
  active: ContactRow[];
  members: Member[];
  canEdit: boolean;
  canDecide: boolean;
  reload(): Promise<void>;
  notify(kind: "info" | "warn", text: string): void;
  push(a: Action): void;
}

const say = (e: unknown, fallback: string) => (e instanceof ApiError ? (e.status === 0 ? "You are offline. This needs a connection." : e.message) : fallback);

/**
 * Contacts and Enquiries: the company's contact list and the enquiry register. Both are company-wide and saved as they are edited (they are
 * not checked out), so undo and redo here save the earlier value back. An enquiry is the job record itself, which is why it becomes the tender.
 */
export function ContactsPage({ tab }: { tab: ContactsTab }) {
  const { session } = useSession();
  const role = session!.role;
  const [jobs, setJobs] = useState<EnquiryJob[] | null>(null);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [notice, setNotice] = useState<{ kind: "info" | "warn"; text: string } | null>(null);
  const [hist, setHist] = useState<ActionHistory>(none());

  const load = useCallback(async () => {
    try {
      const [j, c, m] = await Promise.all([api<EnquiryJob[]>("GET", "/jobs"), api<ContactRow[]>("GET", "/contacts?archived=1"), api<Member[]>("GET", "/org/members")]);
      setJobs(j); setContacts(c); setMembers(m);
    } catch (e) { setNotice({ kind: "warn", text: say(e, "Could not load the register.") }); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const step = useCallback(async (dir: "back" | "forward") => {
    try {
      const r = await (dir === "back" ? stepBack(hist) : stepForward(hist));
      if (!r) return;
      setHist(r.history);
      await load();
      setNotice({ kind: "info", text: `${dir === "back" ? "Undid" : "Redid"}: ${r.label}` });
    } catch (e) { setNotice({ kind: "warn", text: say(e, "That could not be saved, so nothing was changed.") }); }
  }, [hist, load]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!(e.ctrlKey || e.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); void step("back"); }
      else if (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey)) { e.preventDefault(); void step("forward"); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [step]);

  const env: Env = {
    jobs: jobs ?? [], contacts, active: contacts.filter((c) => !c.archived_at), members,
    canEdit: role !== "viewer", canDecide: role === "manager" || role === "owner",
    reload: load, notify: (kind, text) => setNotice({ kind, text }), push: (a) => setHist((h) => record(h, a)),
  };

  const nav = <CompanyNav current={tab} />;

  return (
    <Shell crumbs={[{ label: "Tender Register", href: hrefJobs() }, { label: "Contacts and Enquiries" }, { label: tab === "enquiries" ? "Enquiries" : "Contacts" }]} nav={nav} plain>
      <div className="strip">
        <button className="btn" disabled={hist.past.length === 0} onClick={() => void step("back")} title="Ctrl+Z">Undo</button>
        <button className="btn" disabled={hist.future.length === 0} onClick={() => void step("forward")} title="Ctrl+Y">Redo</button>
        <span className="muted">{env.canEdit ? "Changes are saved as you make them." : "You can look but not change anything."}</span>
      </div>
      {notice && <div className={`notice ${notice.kind}`} role="alert">{notice.text}<button onClick={() => setNotice(null)}>Dismiss</button></div>}
      {jobs === null ? <div className="empty">Loading…</div> : tab === "enquiries" ? <EnquiryRegister env={env} /> : <ContactList env={env} />}
    </Shell>
  );
}
