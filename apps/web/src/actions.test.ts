import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelsView } from "./api.ts";

const { models } = vi.hoisted(() => ({
  models: vi.fn<(workspaceId: string) => Promise<ModelsView>>(),
}));

vi.mock("./api.ts", () => ({ api: { models } }));
vi.mock("./ws.ts", () => ({ connectWs: vi.fn() }));

import { refreshModels } from "./actions.ts";
import { $activeWorkspaceId, $workspaceDefaultModel, $workspaceModels } from "./stores.ts";

const view = (id: string): ModelsView => ({
  models: [{ id, label: id, provider: "test", modelId: id }],
  providers: [],
  defaultModel: id,
  scoutModel: null,
  cardModels: [],
});

describe("refreshModels", () => {
  beforeEach(() => {
    models.mockReset();
    $workspaceModels.set([]);
    $workspaceDefaultModel.set(null);
  });

  it("ignores a response for a workspace that is no longer active", async () => {
    let resolve!: (result: ModelsView) => void;
    models.mockReturnValue(new Promise((done) => { resolve = done; }));
    $activeWorkspaceId.set("workspace-a");

    const refresh = refreshModels("workspace-a");
    $activeWorkspaceId.set("workspace-b");
    resolve(view("model-a"));
    await refresh;

    expect($workspaceModels.get()).toEqual([]);
    expect($workspaceDefaultModel.get()).toBeNull();
  });

  it("stores models and the default for the active workspace", async () => {
    $activeWorkspaceId.set("workspace-a");
    models.mockResolvedValue(view("model-a"));

    await refreshModels("workspace-a");

    expect($workspaceModels.get()).toEqual(view("model-a").models);
    expect($workspaceDefaultModel.get()).toBe("model-a");
  });
});
