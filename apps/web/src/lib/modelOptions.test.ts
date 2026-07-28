import { describe, expect, it } from "vitest";
import type { ModelsView } from "../api.ts";
import { defaultCardModelId, defaultRepoChatModelId, preferredCardModelOptions } from "./modelOptions.ts";

const codexDefault = "pi-openai-codex:gpt-5.6-sol";
const claudeModel = "pi-claude-bridge:claude-sonnet-4-6";

function modelsView(overrides: Partial<ModelsView> = {}): ModelsView {
  return {
    models: [],
    providers: [],
    defaultModel: codexDefault,
    scoutModel: null,
    cardModels: [],
    ...overrides,
  };
}

describe("new-card model defaults", () => {
  it("preserves the configured card model order even when another model is the workspace default", () => {
    const terraModel = "pi-openai-codex:gpt-5.6-terra";
    const view = modelsView({
      models: [
        { id: codexDefault, label: "GPT-5.6 Sol", provider: "openai-codex", modelId: "gpt-5.6-sol" },
        { id: terraModel, label: "GPT-5.6 Terra", provider: "openai-codex", modelId: "gpt-5.6-terra" },
        { id: claudeModel, label: "Claude Sonnet 4.6", provider: "claude-bridge", modelId: "claude-sonnet-4-6" },
      ],
      defaultModel: terraModel,
      cardModels: [codexDefault, terraModel, claudeModel],
    });

    expect(preferredCardModelOptions(view).map((option) => option.id)).toEqual([
      codexDefault,
      terraModel,
      claudeModel,
    ]);
  });

  it("appends an unlisted workspace default without reordering card models", () => {
    const terraModel = "pi-openai-codex:gpt-5.6-terra";
    const view = modelsView({
      models: [
        { id: codexDefault, label: "GPT-5.6 Sol", provider: "openai-codex", modelId: "gpt-5.6-sol" },
        { id: claudeModel, label: "Claude Sonnet 4.6", provider: "claude-bridge", modelId: "claude-sonnet-4-6" },
        { id: terraModel, label: "GPT-5.6 Terra", provider: "openai-codex", modelId: "gpt-5.6-terra" },
      ],
      defaultModel: terraModel,
      cardModels: [codexDefault, claudeModel],
    });

    expect(preferredCardModelOptions(view).map((option) => option.id)).toEqual([
      codexDefault,
      claudeModel,
      terraModel,
    ]);
  });

  it("defaults to Claude when the user has Claude but not ChatGPT", () => {
    const view = modelsView({
      models: [{ id: claudeModel, label: "Claude Sonnet 4.6", provider: "claude-bridge", modelId: "claude-sonnet-4-6" }],
    });

    const options = preferredCardModelOptions(view, [
      { id: "claude-code", label: "Claude Code", configured: true, authKind: "subscription", modelCount: 1 },
      { id: "openai-codex", label: "ChatGPT Codex", configured: false, authKind: "subscription", modelCount: 0 },
    ]);

    expect(options).toEqual([
      { id: codexDefault, label: "GPT-5.6 Sol", configured: false },
      { id: claudeModel, label: "Claude Sonnet 4.6", configured: true },
    ]);
    expect(defaultCardModelId(options, codexDefault, view.defaultModel)).toBe(claudeModel);
  });

  it("keeps a remembered model when it is available", () => {
    const options = [
      { id: codexDefault, label: "GPT-5.6 Sol", configured: true },
      { id: claudeModel, label: "Claude Sonnet 4.6", configured: true },
    ];

    expect(defaultCardModelId(options, claudeModel, codexDefault)).toBe(claudeModel);
  });
});

describe("repo-chat model defaults", () => {
  const models = [
    { id: "model-a", label: "Model A", provider: "a", modelId: "a" },
    { id: "model-b", label: "Model B", provider: "b", modelId: "b" },
  ];

  it("prefers the workspace default over the first available model", () => {
    expect(defaultRepoChatModelId(models, "", "model-b")).toBe("model-b");
  });

  it("preserves an available user selection", () => {
    expect(defaultRepoChatModelId(models, "model-a", "model-b")).toBe("model-a");
  });

  it("falls back when the workspace default is unavailable", () => {
    expect(defaultRepoChatModelId(models, "", "model-c")).toBe("model-a");
  });
});
