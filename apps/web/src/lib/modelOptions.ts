import type { ModelInfo, ModelsView, ProviderStatus } from "../api.ts";

export interface CardModelOption {
  id: string;
  label: string;
  configured: boolean;
}

export const FALLBACK_MODEL_OPTIONS = [
  { id: "pi-openai-codex:gpt-5.6-sol", label: "GPT-5.6 Sol", configured: false },
  { id: "pi-openai-codex:gpt-5.5", label: "GPT-5.5", configured: false },
  { id: "pi-openai-codex:gpt-5.4", label: "GPT-5.4", configured: false },
];

// Legacy backend ids that predate the "pi-<provider>:<modelId>" format.
const LEGACY_BACKEND_PROVIDERS: Record<string, string> = {
  "pi-gpt-5.4": "openai-codex",
  "pi-gpt-5.5": "openai-codex",
};

function providerFromBackendId(id: string): string | null {
  if (LEGACY_BACKEND_PROVIDERS[id]) return LEGACY_BACKEND_PROVIDERS[id]!;
  const match = /^pi-(.+):/.exec(id);
  return match?.[1] ?? null;
}

/**
 * Models offered for per-card selection: preferred card models in their
 * configured order, plus the workspace default if it is not already listed.
 */
export function preferredCardModelOptions(
  view: ModelsView,
  personalProviders: ProviderStatus[] = [],
): CardModelOption[] {
  const fallbackLabels = new Map(FALLBACK_MODEL_OPTIONS.map((m) => [m.id, m.label]));
  const labelFor = (id: string) => view.models.find((m) => m.id === id)?.label ?? fallbackLabels.get(id) ?? id;
  const availableModelIds = new Set(view.models.map((m) => m.id));
  const configuredProviderIds = new Set([
    ...view.providers.filter((p) => p.configured).map((p) => p.id),
    // Server-wide/env credentials surface models in view.models even if the
    // provider status came from elsewhere, so treat those providers as usable.
    ...view.models.map((m) => m.provider),
    ...personalProviders.filter((p) => p.configured).map((p) => p.id),
  ]);
  const configuredFor = (id: string): boolean => {
    if (availableModelIds.has(id)) return true;
    const provider = providerFromBackendId(id);
    return provider ? configuredProviderIds.has(provider) : false;
  };
  const picked = Array.from(new Set([...view.cardModels, view.defaultModel].filter((x): x is string => !!x)));
  if (!picked.length) {
    return view.models.length ? view.models.map((m) => ({ id: m.id, label: m.label, configured: true })) : FALLBACK_MODEL_OPTIONS;
  }

  const preferred = picked.map((id) => ({ id, label: labelFor(id), configured: configuredFor(id) }));
  if (preferred.some((option) => option.configured)) return preferred;

  // If none of the workspace's preferred models can run for this user, expose
  // their available models as fallbacks. This mirrors the server-side card
  // default and prevents a stale Codex default from hiding Claude Code.
  return [
    ...preferred,
    ...view.models
      .filter((model) => !picked.includes(model.id))
      .map((model) => ({ id: model.id, label: model.label, configured: true })),
  ];
}

/** Pick the initial model without preferring a remembered unavailable model. */
export function defaultCardModelId(
  options: CardModelOption[],
  current: string,
  workspaceDefault: string | null,
): string {
  const configured = options.filter((option) => option.configured);
  if (configured.length) {
    if (configured.some((option) => option.id === current)) return current;
    if (workspaceDefault && configured.some((option) => option.id === workspaceDefault)) return workspaceDefault;
    return configured[0]!.id;
  }

  if (options.some((option) => option.id === current)) return current;
  if (workspaceDefault && options.some((option) => option.id === workspaceDefault)) return workspaceDefault;
  return options[0]?.id ?? current;
}

/** Preserve an available user selection, otherwise prefer the workspace default. */
export function defaultRepoChatModelId(
  models: ModelInfo[],
  current: string,
  workspaceDefault: string | null,
): string {
  if (models.some((model) => model.id === current)) return current;
  if (workspaceDefault && models.some((model) => model.id === workspaceDefault)) return workspaceDefault;
  return models[0]?.id ?? "";
}
