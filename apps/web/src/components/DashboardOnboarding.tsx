import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";

const githubDismissKey = (userId: string) => `manta:onboarding:github-dismissed:${userId}`;

export function DashboardOnboarding({
  workspaceId,
  userId,
  githubLogin,
  githubNeedsRelink,
  workerCount,
  workerEverConnected,
  localWorkerOnboardingDismissed,
  onOpenWorkers,
  onDismissLocalWorker,
  onOpenAccount,
  onOpenModels,
}: {
  workspaceId: string;
  userId: string;
  githubLogin: string | null;
  githubNeedsRelink: boolean;
  workerCount: number;
  workerEverConnected: boolean;
  localWorkerOnboardingDismissed: boolean;
  onOpenWorkers: () => void;
  onDismissLocalWorker: () => void;
  onOpenAccount: () => void;
  onOpenModels: () => void;
}) {
  const [modelAuthConnected, setModelAuthConnected] = useState<boolean | null>(null);
  const [modelAuthLabel, setModelAuthLabel] = useState<string | null>(null);
  const [githubDismissed, setGithubDismissed] = useState(() => localStorage.getItem(githubDismissKey(userId)) === "1");

  useEffect(() => {
    setGithubDismissed(localStorage.getItem(githubDismissKey(userId)) === "1");
  }, [userId]);

  const load = useCallback(() => {
    Promise.all([api.userProviders(), api.models(workspaceId)]).then(([userProviders, models]) => {
      const codex = userProviders.providers.find((p) => p.id === "openai-codex" && p.configured);
      const claudeCode = userProviders.providers.find((p) => p.id === "claude-code" && p.configured);
      const anthropic = models.providers.find((p) => p.id === "anthropic" && p.configured);
      const connected = codex ?? claudeCode ?? anthropic;
      setModelAuthConnected(Boolean(connected));
      setModelAuthLabel(connected?.label ?? null);
    }).catch(() => {
      setModelAuthConnected(false);
      setModelAuthLabel(null);
    });
  }, [workspaceId]);

  useEffect(load, [load]);

  const modelAuthDone = modelAuthConnected === true;
  const steps = useMemo(() => {
    const showWorkerStep = !workerEverConnected && !localWorkerOnboardingDismissed;
    const visible = [
      !githubDismissed,
      showWorkerStep,
      modelAuthConnected !== null,
    ];
    const done = [
      !githubDismissed && Boolean(githubLogin) && !githubNeedsRelink,
      showWorkerStep && workerCount > 0,
      modelAuthDone,
    ];
    return { total: visible.filter(Boolean).length, done: done.filter(Boolean).length };
  }, [githubDismissed, githubLogin, githubNeedsRelink, localWorkerOnboardingDismissed, workerCount, workerEverConnected, modelAuthConnected, modelAuthDone]);

  const dismissGithub = () => {
    localStorage.setItem(githubDismissKey(userId), "1");
    setGithubDismissed(true);
  };

  // Closed by default: render nothing until integration state has loaded AND a
  // step is still incomplete. This way a fully-set-up user never sees the card
  // flash in during the initial fetch — it only opens when there's work to do.
  if (modelAuthConnected === null) return null;
  if (steps.done >= steps.total) return null;

  return (
    <aside className="onboarding-card" aria-label="Dashboard onboarding">
      <div className="onboarding-head">
        <div>
          <div className="onboarding-eyebrow">Get connected</div>
          <h3>Finish setting up your workspace</h3>
        </div>
        <span className="onboarding-progress">{steps.done}/{steps.total}</span>
      </div>

      {!githubDismissed && (
        <div className={`onboarding-step ${githubLogin && !githubNeedsRelink ? "done" : ""}`}>
          <span className="onboarding-icon"><GithubIcon /></span>
          <div className="onboarding-copy">
            <strong>{githubNeedsRelink ? `Reconnect GitHub for @${githubLogin}` : githubLogin ? `GitHub connected as @${githubLogin}` : "Are you an engineer?"}</strong>
            <span>{githubNeedsRelink ? "Reconnect GitHub so Manta can create PRs as you instead of the Manta bot." : githubLogin ? "Your PRs can appear on the board." : "Connect GitHub so Manta can find your pull requests."}</span>
            {(!githubLogin || githubNeedsRelink) && (
              <div className="onboarding-actions">
                <a className="btn primary small" href={api.githubLinkUrl()}>{githubNeedsRelink ? "Reconnect GitHub" : "Connect GitHub"}</a>
                {!githubNeedsRelink && <button className="btn ghost small" onClick={dismissGithub}>I don't use GitHub</button>}
              </div>
            )}
          </div>
        </div>
      )}

      {!workerEverConnected && !localWorkerOnboardingDismissed && (
        <div className={`onboarding-step ${workerCount > 0 ? "done" : ""}`}>
          <span className="onboarding-icon"><WorkerIcon /></span>
          <div className="onboarding-copy">
            <strong>{workerCount > 0 ? `${workerCount} worker${workerCount === 1 ? "" : "s"} connected` : "Connect your worker"}</strong>
            <span>{workerCount > 0 ? "Ready to pick up tasks from this dashboard." : "Pair a local worker so Manta can run tasks for you, or skip this if you only use cloud sandboxes."}</span>
            <div className="onboarding-actions">
              <button className="btn small" onClick={onOpenWorkers}>{workerCount > 0 ? "Manage workers" : "View pairing steps"}</button>
              {workerCount === 0 && <button className="btn ghost small" onClick={onDismissLocalWorker}>Use cloud sandboxes only</button>}
            </div>
          </div>
        </div>
      )}

      <div className={`onboarding-step ${modelAuthDone ? "done" : ""}`}>
        <span className="onboarding-icon"><CodexIcon /></span>
        <div className="onboarding-copy">
          {modelAuthDone ? (
            <>
              <strong>{modelAuthLabel ?? "Model credentials"} connected</strong>
              <span>Your tasks can run on your connected Codex or Anthropic credentials.</span>
            </>
          ) : (
            <>
              <strong>Connect Codex or Anthropic</strong>
              <span>Link a ChatGPT/Codex subscription or add an Anthropic API key so tasks use your credentials. If you skip this, Manta shares available teammates' subscriptions.</span>
              <div className="onboarding-actions">
                <button className="btn small" onClick={onOpenAccount}>Connect Codex</button>
                <button className="btn ghost small" onClick={onOpenModels}>Add Anthropic key</button>
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

// Step icons — match the app's stroke-icon style (currentColor, ~14px).
function GithubIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
    </svg>
  );
}

function WorkerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.6 6.4L6.6 8l-2 1.6M8.2 9.6h3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CodexIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 8h5M8 5.5v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
