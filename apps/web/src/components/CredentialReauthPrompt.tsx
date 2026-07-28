import { useCallback, useEffect, useState } from "react";
import { api, type ProviderStatus } from "../api.ts";

/**
 * A prominent, persistent prompt shown when one of the current user's
 * subscription credentials has expired and couldn't refresh (the server flags it
 * after a turn fails). Unlike the onboarding checklist, this shows even for a
 * fully set-up user — a dead credential silently stalls every card, so it must be
 * impossible to miss. Reconnecting routes to the existing provider settings flow.
 */
export function CredentialReauthPrompt({ onReconnect }: { onReconnect: () => void }) {
  const [stale, setStale] = useState<ProviderStatus[]>([]);

  const load = useCallback(() => {
    api
      .userProviders()
      .then((view) => setStale(view.providers.filter((p) => p.needsReauth)))
      .catch(() => {
        /* leave the last known state; a transient fetch error shouldn't hide it */
      });
  }, []);

  useEffect(() => {
    load();
    // Re-login happens out of band (settings panel / daemon), and the server
    // clears the flag on reconnect — so poll and refetch on focus to dismiss the
    // prompt promptly once it's fixed (and surface a fresh failure within ~a min).
    const interval = setInterval(load, 60_000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", load);
    };
  }, [load]);

  if (stale.length === 0) return null;

  const labels = stale.map((p) => p.label).join(" and ");
  return (
    <aside className="onboarding-card reauth-card" aria-label="Credential re-login required" role="alert">
      <div className="onboarding-head">
        <div>
          <div className="onboarding-eyebrow warn">Action required</div>
          <h3>Re-login to {labels}</h3>
        </div>
      </div>
      <div className="onboarding-step">
        <span className="onboarding-icon">⚠️</span>
        <div className="onboarding-copy">
          <strong>Your {labels} subscription expired and couldn't refresh</strong>
          <span>
            Until you re-login, cards running on it stall with no output. Reconnect to restore your
            tasks.
          </span>
          <div className="onboarding-actions">
            <button className="btn primary small" onClick={onReconnect}>Re-login</button>
          </div>
        </div>
      </div>
    </aside>
  );
}
