import { useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../lib/app";

export function Auth() {
  const { session, reloadSession } = useApp();
  const setup = session?.setupRequired;
  const [mode, setMode] = useState<"login" | "register">(setup ? "register" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        await api.post("/api/auth/register", { email, password, displayName: name || email.split("@")[0], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      } else {
        await api.post("/api/auth/login", { email, password });
      }
      await reloadSession();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="box">
        <div className="masthead" style={{ marginBottom: 6 }}>
          <h1>The Signal</h1>
        </div>
        <p className="page-sub" style={{ textAlign: "center" }}>Your newspaper, always current.</p>
        <form className="panel" onSubmit={submit} aria-labelledby="auth-title">
          <h2 id="auth-title">{setup ? "Set up this newspaper" : mode === "register" ? "Create an account" : "Sign in"}</h2>
          {setup && <p className="page-sub">No accounts exist yet. The first account becomes the administrator, who can monitor sources, jobs and AI processing.</p>}
          {mode === "register" && (
            <div className="field">
              <label htmlFor="name">Display name</label>
              <input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              required
              minLength={mode === "register" ? 10 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "register" ? "new-password" : "current-password"}
            />
            {mode === "register" && <span className="hint">At least 10 characters.</span>}
          </div>
          {error && (
            <div className="notice error" role="alert" style={{ marginBottom: 12 }}>
              <div>{error}</div>
            </div>
          )}
          <button className="btn primary" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}
          </button>
          {!setup && (
            <p style={{ textAlign: "center", fontSize: "0.88rem", marginBottom: 0 }}>
              {mode === "login" ? (
                session?.signupAllowed ? (
                  <button type="button" className="btn ghost sm" onClick={() => setMode("register")}>Create an account</button>
                ) : (
                  <span className="meta">New accounts are created by invitation from the administrator.</span>
                )
              ) : (
                <button type="button" className="btn ghost sm" onClick={() => setMode("login")}>I already have an account</button>
              )}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
