import { useState } from "react";
import { useStore } from "@nanostores/react";
import { api } from "../api.ts";
import { $me } from "../stores.ts";
import { clearPairRequest, isLoopbackCallback, type PairRequest } from "../lib/pairing.ts";
import { Logo } from "./ui.tsx";

// Shown when a worker daemon opened the browser to pair. Approving mints a
// per-user token and redirects back to the daemon's loopback listener.
export function PairWorker({ req, onCancel }: { req: PairRequest; onCancel: () => void }) {
  const me = useStore($me)!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (!isLoopbackCallback(req.callback)) throw new Error("Refusing to send token to a non-loopback address.");
      const { token } = await api.pairWorker(req.name);
      const url = new URL(req.callback);
      url.searchParams.set("token", token);
      url.searchParams.set("state", req.state);
      clearPairRequest();
      window.location.assign(url.toString());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Pairing failed");
      setBusy(false);
    }
  };

  const cancel = () => { clearPairRequest(); onCancel(); };
  const badCallback = !isLoopbackCallback(req.callback);

  return (
    <div className="center">
      <div className="card login">
        <h1><Logo /> Pair worker</h1>
        <p className="muted">
          A worker daemon on <strong>{req.name}</strong> wants to pair with your account
          and run tasks you create as <strong>{me.email}</strong>.
        </p>
        {badCallback && <p className="muted" style={{ color: "var(--danger, #c33)" }}>
          This pairing link points somewhere other than your local machine and was blocked.
        </p>}
        {err && <p className="muted" style={{ color: "var(--danger, #c33)" }}>{err}</p>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn primary" disabled={busy || badCallback} onClick={approve}>
            {busy ? "Pairing…" : "Approve"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={cancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
