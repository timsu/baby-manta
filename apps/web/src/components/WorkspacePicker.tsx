import { useState } from "react";
import { useStore } from "@nanostores/react";
import { $me } from "../stores.ts";
import { newWorkspace } from "../actions.ts";
import { acceptInviteAndEnter, parseInviteInput } from "../lib/invite.ts";
import { Logo } from "./ui.tsx";

export function WorkspacePicker() {
  const me = useStore($me)!;
  const [mode, setMode] = useState<"choose" | "create" | "join">("choose");
  const [name, setName] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = async () => {
    const code = parseInviteInput(codeInput);
    if (!code || busy) return;
    setBusy(true); setError(null);
    try {
      await acceptInviteAndEnter(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid invite code");
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="card login">
        <h1><Logo /> Manta</h1>
        {mode === "choose" && (
          <>
            <p className="muted">Hi {me.email} — get started.</p>
            <button className="btn primary" onClick={() => setMode("create")}>Create a workspace</button>
            <button className="btn" onClick={() => { setError(null); setMode("join"); }}>Join with an invite code</button>
          </>
        )}
        {mode === "create" && (
          <>
            <p className="muted">Name your workspace.</p>
            <input value={name} placeholder="Workspace name (e.g. Acme)" autoFocus
                   onChange={(e) => setName(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && name.trim() && void newWorkspace(name.trim())} />
            <button className="btn primary" disabled={!name.trim()} onClick={() => void newWorkspace(name.trim())}>
              Create workspace
            </button>
            <button className="btn ghost" onClick={() => setMode("choose")}>← Back</button>
          </>
        )}
        {mode === "join" && (
          <>
            <p className="muted">Paste your invite code or link.</p>
            <input value={codeInput} placeholder="Invite code or link" autoFocus
                   onChange={(e) => setCodeInput(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && void join()} />
            {error && <p className="error-text">{error}</p>}
            <button className="btn primary" disabled={busy || !codeInput.trim()} onClick={() => void join()}>
              {busy ? "Joining…" : "Join workspace"}
            </button>
            <button className="btn ghost" onClick={() => setMode("choose")}>← Back</button>
          </>
        )}
      </div>
    </div>
  );
}
