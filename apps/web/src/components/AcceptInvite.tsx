import { useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import { api, type InvitationPreview } from "../api.ts";
import { $me } from "../stores.ts";
import { acceptInviteAndEnter, clearInviteCode } from "../lib/invite.ts";
import { Logo } from "./ui.tsx";

export function AcceptInvite({ code, onClose }: { code: string; onClose: () => void }) {
  const me = useStore($me)!;
  const [preview, setPreview] = useState<InvitationPreview | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.invitationPreview(code).then(setPreview).catch(() => setPreview(null));
  }, [code]);

  const decline = () => { clearInviteCode(); onClose(); };

  const accept = async () => {
    setBusy(true); setError(null);
    try {
      await acceptInviteAndEnter(code);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept invite");
      setBusy(false);
    }
  };

  return (
    <div className="center">
      <div className="card login">
        <h1><Logo /> Manta</h1>
        {preview === undefined && <p className="muted">Loading invite…</p>}
        {preview === null && (
          <>
            <p className="muted">This invite link is invalid or no longer exists.</p>
            <button className="btn primary" onClick={decline}>Continue</button>
          </>
        )}
        {preview && !preview.valid && (
          <>
            <p className="muted">The invite to <strong>{preview.workspaceName}</strong> has expired or been revoked.</p>
            <button className="btn primary" onClick={decline}>Continue</button>
          </>
        )}
        {preview && preview.valid && (
          <>
            <p className="muted">Hi {me.email} — you've been invited to join <strong>{preview.workspaceName}</strong> as {preview.role}.</p>
            {error && <p className="error-text">{error}</p>}
            <button className="btn primary" disabled={busy} onClick={() => void accept()}>
              {busy ? "Joining…" : `Join ${preview.workspaceName}`}
            </button>
            <button className="btn ghost" disabled={busy} onClick={decline}>Not now</button>
          </>
        )}
      </div>
    </div>
  );
}
