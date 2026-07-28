import { describe, expect, it } from "vitest";

import { gitRemoteMatchesRepo, isCorruptRepoError, repoSlugFromGitRemote } from "./repoIdentity.ts";

describe("repoSlugFromGitRemote", () => {
  it("parses https GitHub remotes", () => {
    expect(repoSlugFromGitRemote("https://github.com/acme/platform.git")).toBe("acme/platform");
  });

  it("parses ssh/scp GitHub remotes", () => {
    expect(repoSlugFromGitRemote("git@github.com:Acme/Manta.git")).toBe("acme/manta");
  });

  it("rejects non-GitHub or malformed remotes", () => {
    expect(repoSlugFromGitRemote("/Users/me/.manta/repos/acme__platform.git")).toBeNull();
    expect(repoSlugFromGitRemote("https://gitlab.com/acme/platform.git")).toBeNull();
  });
});

describe("gitRemoteMatchesRepo", () => {
  it("matches case-insensitively and ignores .git", () => {
    expect(gitRemoteMatchesRepo("git@github.com:Acme/Platform.git", "acme/platform")).toBe(true);
  });

  it("detects a cache/worktree pointed at the wrong repo", () => {
    expect(gitRemoteMatchesRepo("https://github.com/acme/manta.git", "acme/platform")).toBe(false);
  });
});

describe("isCorruptRepoError", () => {
  it("flags a rotted object store so the cache is re-cloned, not retried", () => {
    // The exact wedge this fix targets: fetch --prune on a blobless cache whose
    // refs outlived their objects.
    expect(isCorruptRepoError("git fetch for acme/manta failed: fatal: object defedee93f877aaefd51ae122b7681ffef658832 not found")).toBe(true);
    expect(isCorruptRepoError("fatal: bad tree object 300e38f582ec4acbd710223318646cecc20c1d25")).toBe(true);
    expect(isCorruptRepoError("error: https://github.com/acme/manta.git did not send all necessary objects")).toBe(true);
    expect(isCorruptRepoError("error: refs/heads/foo: invalid sha1 pointer 8488e66e05609b1273cd778b5f60a38b7ed4038d")).toBe(true);
    expect(isCorruptRepoError("missing blob d2aad092fc64d916986727c8220a43bf6face7f3")).toBe(true);
  });

  it("leaves transient network/auth failures to be retried, not re-cloned", () => {
    expect(isCorruptRepoError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(false);
    expect(isCorruptRepoError("fatal: unable to access 'https://github.com/...': Could not resolve host: github.com")).toBe(false);
    expect(isCorruptRepoError("git fetch for acme/manta timed out after 120s")).toBe(false);
  });
});
