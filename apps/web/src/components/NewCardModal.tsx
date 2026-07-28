import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "@nanostores/react";
import { api, type CardType } from "../api.ts";
import { $activeWorkspaceId, $repos, addToast } from "../stores.ts";
import { refreshTasks } from "../actions.ts";
import { openTask } from "../ws.ts";
import { type PastedImage, uploadPastedImageMarkdown } from "../lib/images.ts";
import { useDebouncedLocalStorageDraft } from "../lib/localStorageDraft.ts";
import { defaultCardModelId, FALLBACK_MODEL_OPTIONS, preferredCardModelOptions, type CardModelOption } from "../lib/modelOptions.ts";
import { Modal } from "./ui.tsx";
import { MentionTextarea } from "./MentionTextarea.tsx";

const TYPES: { type: CardType; emoji: string; label: string; desc: string }[] = [
  { type: "bot", emoji: "🤖", label: "Bot", desc: "Agent works on this in the background." },
  { type: "investigation", emoji: "🔎", label: "Investigation", desc: "Agent investigates read-only and reports findings without a PR." },
  { type: "interactive", emoji: "💬", label: "Interactive", desc: "A worktree is created for you to pair with an agent." },
  { type: "plan", emoji: "📋", label: "Plan", desc: "Agent drafts a proposal for you to approve before any code changes." },
  { type: "backlog", emoji: "🗂", label: "Backlog", desc: "No worktree — just a chat on top of the repo until you're ready." },
];
const CARD_DEFAULTS_KEY = "manta:new-card-defaults";
const CARD_DRAFT_KEY_PREFIX = "manta:new-card-draft";
const CARD_IMAGE_DRAFT_KEY_PREFIX = "manta:new-card-image-draft";
function loadCardDefaults() {
  try { return JSON.parse(localStorage.getItem(CARD_DEFAULTS_KEY) ?? "{}") as { repo?: string; cardType?: CardType; backend?: string }; }
  catch { return {}; }
}
function saveCardDefaults(d: { repo: string; cardType: CardType; backend: string }) {
  localStorage.setItem(CARD_DEFAULTS_KEY, JSON.stringify(d));
}

function loadPastedImageDraft(key: string): PastedImage[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PastedImage => {
      const candidate = item as Partial<PastedImage>;
      return typeof candidate.id === "string"
        && typeof candidate.name === "string"
        && typeof candidate.dataUrl === "string"
        && candidate.dataUrl.startsWith("data:image/");
    });
  } catch {
    return [];
  }
}

function savePastedImageDraft(key: string, images: PastedImage[]) {
  try {
    if (images.length > 0) localStorage.setItem(key, JSON.stringify(images));
    else localStorage.removeItem(key);
  } catch {
    // Ignore storage failures (private mode, quota, etc.). Draft persistence is best-effort.
  }
}

type WorkerVenue = "laptop" | "daytona";

export function NewCardModal({
  onClose,
  initialPrompt = "",
  initialRepo,
  initialLinearIssueIdentifier,
  onRepoUsed,
}: {
  onClose: () => void;
  initialPrompt?: string;
  initialRepo?: string | null;
  initialLinearIssueIdentifier?: string | null;
  onRepoUsed?: (repo: string) => void;
}) {
  const repos = useStore($repos);
  const workspaceId = $activeWorkspaceId.get()!;
  const defaults = useMemo(loadCardDefaults, []);
  const promptDraftKey = `${CARD_DRAFT_KEY_PREFIX}:${workspaceId}`;
  const imageDraftKey = `${CARD_IMAGE_DRAFT_KEY_PREFIX}:${workspaceId}`;
  const [prompt, setPrompt, clearPromptDraft] = useDebouncedLocalStorageDraft(promptDraftKey);
  const [repo, setRepo] = useState(
    initialRepo && repos.some((r) => r.orgRepo === initialRepo)
      ? initialRepo
      : defaults.repo && repos.some((r) => r.orgRepo === defaults.repo) ? defaults.repo : repos[0]?.orgRepo ?? "",
  );
  const repoLockedToLinear = Boolean(initialLinearIssueIdentifier && initialRepo && repos.some((r) => r.orgRepo === initialRepo));
  useEffect(() => {
    if (repoLockedToLinear && initialRepo) setRepo(initialRepo);
  }, [initialRepo, repoLockedToLinear]);
  useEffect(() => { if (initialPrompt) setPrompt(initialPrompt); }, [initialPrompt, setPrompt]);
  const [cardType, setCardType] = useState<CardType>(defaults.cardType ?? "bot");
  const [backend, setBackend] = useState(defaults.backend ?? "pi-openai-codex:gpt-5.6-sol");
  const [backends, setBackends] = useState<CardModelOption[]>(FALLBACK_MODEL_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [repoFiles, setRepoFiles] = useState<string[]>([]);
  const [pastedImages, setPastedImages] = useState<PastedImage[]>(() => loadPastedImageDraft(imageDraftKey));
  const [localWorkerAvailable, setLocalWorkerAvailable] = useState(false);
  const [workerVenue, setWorkerVenue] = useState<WorkerVenue>("daytona");
  const [workerVenueTouched, setWorkerVenueTouched] = useState(false);

  useEffect(() => {
    if (!repo) return;
    setRepoFiles([]);
    api.repoFiles(workspaceId, repo).then((r) => setRepoFiles(r.files)).catch(() => {});
  }, [repo, workspaceId]);

  useEffect(() => {
    setPastedImages(loadPastedImageDraft(imageDraftKey));
  }, [imageDraftKey]);

  useEffect(() => {
    savePastedImageDraft(imageDraftKey, pastedImages);
  }, [imageDraftKey, pastedImages]);

  useEffect(() => {
    api.listWorkers().then((v) => {
      const hasLocalWorker = v.workers.some((w) => w.live);
      setLocalWorkerAvailable(hasLocalWorker);
      if (!workerVenueTouched) setWorkerVenue(hasLocalWorker ? "laptop" : "daytona");
    }).catch(() => {});
  }, [workerVenueTouched]);

  // Model options come from the workspace's model settings (default + extra
  // card models). Fall back to the built-in list if none are configured yet.
  useEffect(() => {
    Promise.all([api.models(workspaceId), api.userProviders().catch(() => ({ providers: [] }))]).then(([v, userProviders]) => {
      const list = preferredCardModelOptions(v, userProviders.providers);
      setBackends(list);
      setBackend((cur) => defaultCardModelId(list, cur, v.defaultModel));
    }).catch(() => {});
  }, [workspaceId]);

  const create = useCallback(async () => {
    const workspaceId = $activeWorkspaceId.get()!;
    const fullPromptBase = prompt.trim();
    if ((!fullPromptBase && pastedImages.length === 0) || !repo || busy) return;
    setBusy(true);
    onClose();
    try {
      const imageMarkdown = (await Promise.all(
        pastedImages.map((img) => uploadPastedImageMarkdown(workspaceId, img.name, img.dataUrl)),
      )).join("\n");
      const fullPrompt = [fullPromptBase, imageMarkdown].filter(Boolean).join("\n\n");
      const card = await api.createCard(workspaceId, {
        prompt: fullPrompt,
        repo,
        cardType,
        workerBackend: backend,
        workerVenue,
        ...(initialLinearIssueIdentifier ? { linearIssueIdentifier: initialLinearIssueIdentifier } : {}),
      });
      onRepoUsed?.(repo);
      clearPromptDraft();
      savePastedImageDraft(imageDraftKey, []);
      await refreshTasks();
      if (cardType === "interactive") openTask(card.id);
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to create card", "error");
    }
  }, [backend, busy, cardType, clearPromptDraft, imageDraftKey, initialLinearIssueIdentifier, onClose, onRepoUsed, pastedImages, prompt, repo, workerVenue]);

  const [commandDown, setCommandDown] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.key === "Meta") setCommandDown(true);
      if (!e.metaKey) return;
      if (e.key === "Enter") {
        e.preventDefault();
        void create();
        return;
      }
      const idx = Number(e.key) - 1;
      const type = TYPES[idx];
      if (type) {
        e.preventDefault();
        setCardType(type.type);
        saveCardDefaults({ repo, cardType: type.type, backend });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Meta" || !e.metaKey) setCommandDown(false);
    };
    const onBlur = () => setCommandDown(false);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [backend, create, repo]);

  return (
    <Modal title="New card" onClose={onClose}>
      {repos.length === 0 ? (
        <p className="muted">Add a repo to this workspace first (Settings → Repos).</p>
      ) : (
        <>
          <MentionTextarea value={prompt} onChange={setPrompt} files={repoFiles} pastedImages={pastedImages} onPastedImagesChange={setPastedImages} />
          <div className="field"><label>Repo</label>
            <div className="radios">
              {(repoLockedToLinear ? repos.filter((r) => r.orgRepo === initialRepo) : repos).map((r) => (
                <button key={r.id} className={`chip ${repo === r.orgRepo ? "on" : ""}`} onClick={() => { setRepo(r.orgRepo); saveCardDefaults({ repo: r.orgRepo, cardType, backend }); }}>
                  {r.orgRepo}
                </button>
              ))}
            </div>
            {repoLockedToLinear && <span className="s-hint">Repo is set by this Linear issue's team/project mapping.</span>}
          </div>
          <div className="field"><label>Type</label>
            <div className="type-grid">
              {TYPES.map((t, i) => (
                <button key={t.type} className={`type-card ${cardType === t.type ? "on" : ""}`} onClick={() => { setCardType(t.type); saveCardDefaults({ repo, cardType: t.type, backend }); }}>
                  <div className="type-label">
                    <span>{t.emoji} {t.label}</span>
                    {commandDown && <span className="shortcut-hint">⌘{i + 1}</span>}
                  </div>
                  <div className="type-desc">{t.desc}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="field"><label>Model</label>
            <div className="radios">
              {backends.map((b) => (
                <button
                  key={b.id}
                  className={`chip model-chip ${backend === b.id ? "on" : ""}`}
                  title={b.configured ? "Credentials available" : undefined}
                  onClick={() => { setBackend(b.id); saveCardDefaults({ repo, cardType, backend: b.id }); }}
                >
                  {b.configured && <span className="model-availability-dot" aria-hidden="true" />}
                  <span>{b.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="field"><label>Worker</label>
            <div className="radios">
              <button
                className={`chip ${workerVenue === "laptop" ? "on" : ""}`}
                disabled={!localWorkerAvailable}
                title={localWorkerAvailable ? "Use your connected local worker" : "No local worker is online"}
                onClick={() => { setWorkerVenue("laptop"); setWorkerVenueTouched(true); }}
              >
                Local Worker
              </button>
              <button
                className={`chip ${workerVenue === "daytona" ? "on" : ""}`}
                onClick={() => { setWorkerVenue("daytona"); setWorkerVenueTouched(true); }}
              >
                Cloud Worker
              </button>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" disabled={(!prompt.trim() && pastedImages.length === 0) || busy} onClick={create}>
              <span>{busy ? "Creating…" : "Create"}</span>
              {commandDown && <span className="shortcut-hint">⌘⏎</span>}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
