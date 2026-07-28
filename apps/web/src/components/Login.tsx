import { useEffect, useState } from "react";
import { api, authUrl, type AuthMethods } from "../api.ts";
import { Logo } from "./ui.tsx";

export function Login() {
  // Until /methods answers we render neither button, so the card never flashes
  // an option this server does not actually offer.
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.authMethods()
      .then(setMethods)
      // An older server has no /methods route — fall back to Google only.
      .catch(() => setMethods({ google: true, email: false }));
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.loginWithEmail(email);
      // Full reload so every store rehydrates behind the new session cookie.
      window.location.reload();
    } catch (err) {
      setError((err as Error).message === "invalid_email" ? "That doesn't look like an email address." : "Sign-in failed. Is the server running?");
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="card login">
        <h1><Logo /> Manta</h1>
        <p className="muted">Engineering orchestrator.</p>

        {methods?.email && (
          <form onSubmit={signIn} className="login-form">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              aria-label="Email address"
              autoFocus
              required
            />
            <button className="btn primary" type="submit" disabled={busy || !email.trim()}>
              {busy ? "Signing in…" : "Continue with email"}
            </button>
            <p className="muted small">No password — the account is created on first sign-in.</p>
          </form>
        )}

        {methods?.email && methods.google && <div className="login-sep">or</div>}

        {methods?.google && <a className="btn primary" href={authUrl}>Sign in with Google</a>}

        {error && <p className="error small">{error}</p>}
      </div>
    </div>
  );
}
