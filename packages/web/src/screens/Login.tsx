import { type FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api.js";
import { useSession } from "../session.js";

export function Login() {
  const { signIn } = useSession();
  const [mode, setMode] = useState<"in" | "register">("in");
  const [f, setF] = useState({ orgName: "", name: "", email: "", password: "" });
  const [choose, setChoose] = useState<{ orgId: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a hosted Blackline lets only its first company sign up (the rest are added by the administrator), so the tab shows only when the server says it is open
  const [canRegister, setCanRegister] = useState(false);
  useEffect(() => {
    api("GET", "/auth/status").then((r) => setCanRegister(!!r.registration), () => setCanRegister(false));
  }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent, orgId?: string) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mode === "in"
        ? await api("POST", "/auth/login", { email: f.email, password: f.password, orgId })
        : await api("POST", "/auth/register", { orgName: f.orgName, name: f.name, email: f.email, password: f.password });
      if (r.choose) setChoose(r.choose);
      else await signIn(r.token);
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 0 ? "No connection to the server." : err.message) : "Something went wrong.");
    }
    setBusy(false);
  }

  if (choose)
    return (
      <div className="signin">
        <h1>Choose a company</h1>
        <form onSubmit={(e) => e.preventDefault()}>
          {choose.map((o) => <button key={o.orgId} className="btn" onClick={(e) => submit(e, o.orgId)}>{o.name}</button>)}
          {error && <div className="error">{error}</div>}
        </form>
      </div>
    );

  return (
    <div className="signin">
      <h1>Blackline</h1>
      {canRegister && (
        <div className="tabs">
          <button className={mode === "in" ? "on" : ""} onClick={() => { setMode("in"); setError(null); }}>Sign in</button>
          <button className={mode === "register" ? "on" : ""} onClick={() => { setMode("register"); setError(null); }}>New company</button>
        </div>
      )}
      <form onSubmit={submit}>
        {mode === "register" && (
          <>
            <label>Company name<input value={f.orgName} onChange={set("orgName")} required autoFocus /></label>
            <label>Your name<input value={f.name} onChange={set("name")} required /></label>
          </>
        )}
        <label>Email<input type="email" value={f.email} onChange={set("email")} required autoFocus={mode === "in"} autoComplete="username" /></label>
        <label>Password<input type="password" value={f.password} onChange={set("password")} required autoComplete={mode === "in" ? "current-password" : "new-password"} /></label>
        {mode === "register" && <p className="hint">At least 10 characters. You become the owner and can add your team afterwards.</p>}
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy}>{mode === "in" ? "Sign in" : "Create company"}</button>
      </form>
    </div>
  );
}
