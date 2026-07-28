import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "./config.ts";

describe("sandboxForwardEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards the bootstrap keys present on this server", () => {
    vi.stubEnv("MANTA_SANDBOX_FORWARD_ENV", "DOTENV_PRIVATE_KEY_SHARED,DOTENV_PRIVATE_KEY_ABSENT");
    vi.stubEnv("MANTA_SANDBOX_FORWARD_ENV_ALIASES", "");
    vi.stubEnv("DOTENV_PRIVATE_KEY_SHARED", "shared-key");

    expect(config.sandboxForwardEnv()).toEqual({ DOTENV_PRIVATE_KEY_SHARED: "shared-key" });
  });

  it("publishes an alias only when its source is available", () => {
    vi.stubEnv("MANTA_SANDBOX_FORWARD_ENV", "SOURCE_VAR");
    vi.stubEnv("MANTA_SANDBOX_FORWARD_ENV_ALIASES", "SECOND_NAME=SOURCE_VAR");
    vi.stubEnv("SOURCE_VAR", "value");

    expect(config.sandboxForwardEnv()).toEqual({ SOURCE_VAR: "value", SECOND_NAME: "value" });

    vi.stubEnv("SOURCE_VAR", "");

    expect(config.sandboxForwardEnv()).toEqual({});
  });
});
