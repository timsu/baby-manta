// Pi SDK extensions for Manta workers. Ported from the prototype's
// src/backends/pi-extensions.ts.
//
// These npm packages augment the worker's Pi agent with capabilities the bare
// coding tools lack:
//   - pi-vision-proxy          → lets text-only models "see" images by routing
//                                 them to a vision model (+ an analyze_image tool)
//   - context-mode             → sandboxed code execution + FTS5 search that saves
//                                 most of the context window
//   - pi-web-access            → web_search / fetch_content (URLs, GitHub clones,
//                                 PDFs, YouTube/video understanding)
//   - @howaboua/pi-codex-conversion → Codex-style exec_command / apply_patch tool
//                                 surface that GPT/Codex models drive best
//   - @howaboua/pi-auto-reasoning-tool → lets agents adjust their reasoning
//                                 effort as task complexity changes
//   - @trevonistrevon/pi-loop  → cron/event re-wake loops + background monitors
//   - @tintinweb/pi-subagents   → isolated foreground/background Agent runs
//   - @timsu/pi-claude-bridge       → exposes Claude Code Agent SDK models as
//                                 a Pi provider (`claude-bridge/*`)
//                                 (fork of @vanillagreen with concurrent-task isolation)
//
// npm: extension sources passed to Pi as "temporary" extensions get reinstalled
// under /tmp on every resource reload (i.e. every turn). Instead we preload all
// packages once into a stable cache (ensureConfiguredPiExtensionsInstalled) and
// hand Pi the resolved local package dirs (getConfiguredPiExtensionPaths).

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

export const DEFAULT_PI_EXTENSION_SOURCES = [
  "npm:pi-vision-proxy@1.7.1",
  "npm:context-mode@1.0.169",
  "npm:pi-web-access@0.13.0",
  "npm:@howaboua/pi-codex-conversion@2.2.16",
  "npm:@howaboua/pi-auto-reasoning-tool@0.1.11",
  "npm:@trevonistrevon/pi-loop@0.6.4",
  // PINNED: foreground Agent runs are part of the worker protocol, so they must
  // not depend on whichever global Pi package version happens to be installed
  // on a venue. 0.14.x includes foreground lifecycle completion and correctly
  // surfaces failed/empty final turns; the previously cached 0.10.3 could leave
  // the parent waiting after the child had stopped producing useful output.
  "npm:@tintinweb/pi-subagents@0.14.2",
  // Fork of @vanillagreen/pi-claude-bridge with per-turn AsyncLocalStorage
  // isolation so concurrent tasks on the same daemon don't corrupt each other's
  // query context. This is the single-global-session build (no per-cwd/per-task
  // keying). The "per-cwd" (d7b877f) and "per-task" (6c6d562) keying attempts both
  // BROKE MCP tool-result delivery — a card's first tool call never got its result
  // back, so the agent ended after one turn (ENG-6144) — and neither actually
  // isolated (they keyed on `options.cwd ?? process.cwd()`, but Pi's StreamOptions
  // has no cwd, so the key was a constant process.cwd()).
  //
  // Cross-card conversation bleed needs THREE mechanisms, layered:
  //  - Running every bridge turn in a disposable child process prevents
  //    CONCURRENT turns from sharing the global pointer, process cwd, provider
  //    registration, or Claude CLI subprocess. Different cards can still run in
  //    parallel because each gets a different process.
  //  - resetClaudeBridgeRegistration (pi-backend.ts) before every bridge turn
  //    prevents SEQUENTIAL bleed: pi loads extensions with jiti moduleCache:false,
  //    so only the first-ever loaded bridge instance stayed registered, its
  //    global session pointer was never cleared between tasks (embedded sessions
  //    emit session_start reason "startup", which the bridge doesn't clear on),
  //    and a new card's first turn passed the bridge's reuse check (zero prior
  //    messages ⇒ nothing "missed") and resumed the PREVIOUS card's conversation —
  //    which is how three cards' work once landed on one card's branch/PR.
  //  - The bridge itself (1.5.3, timsu/pi-claude-bridge#4) guards its reuse path:
  //    it rotates to a fresh session when the stream cwd changes (the daemon
  //    chdirs into each task's worktree per turn, so a cwd change = a different
  //    task took over) or when pi's history is shorter than the stored cursor
  //    (a brand-new conversation can never be "in sync" with a longer stored one).
  // VERSION: any bridge change MUST bump the package version — npm's name@version
  // cache can't distinguish same-version builds and serves stale bytes (that is
  // how every pre-1.5.2 build got stuck on 1.5.1 bytes).
  // No npm publish needed — the bundle is committed and the tarball URL resolves.
  // Pinned to commit c31e91f (1.5.4, active-turn delivery routing) on the
  // aidenzegil fork; re-pin to upstream once the upstream 1.5.4 series merges.
  //
  // 1.5.4 fixes what the ALS per-turn isolation (in every build since ba6d57c,
  // first picked up here via the 1.5.3 pin) broke: pi delivers tool results on
  // ITS OWN async chain, outside the query's ALS slot, so the bridge saw a fresh
  // context (activeQuery=null), treated every tool result as orphaned, and ended
  // the turn with an empty message — every card turn died after its first tool
  // call and left a wedged Claude CLI subprocess behind. 1.5.4 registers the
  // active turn's store globally and routes out-of-scope provider calls back
  // into it (single-active-turn only, which process isolation guarantees).
  "npm:@timsu/pi-claude-bridge@https://github.com/aidenzegil/pi-claude-bridge/archive/c31e91f7fe1c9c485c1d074a18e50e5b077e3860.tar.gz",
] as const;

// Extensions import these Pi core packages as runtime peers. Install the same
// version Manta itself runs into the cache root so child Agent sessions use the
// same lifecycle implementation as their parent. The extension loader aliases
// legacy pi-ai root imports to /compat, which keeps the bridge's getModels import
// working on this runtime.
// Entries may pin a version (`name@version`) — unpinned ones track latest.
export const PI_EXTENSION_RUNTIME_DEPENDENCIES = [
  "@anthropic-ai/claude-code",
  "@earendil-works/pi-ai@0.81.1",
  "@earendil-works/pi-coding-agent@0.81.1",
  "@earendil-works/pi-tui@0.81.1",
  "typebox",
] as const;

const EXTENSION_INSTALL_METADATA_FILE = ".manta-pi-extension-specs.json";
// OpenAI Responses/Chat reject tool names outside this charset (e.g. `web.run`).
const OPENAI_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface NpmExtensionSource {
  source: string;
  spec: string;
  packageName: string;
  installPath: string;
}

interface ExtensionInstallMetadata {
  npmSpecs: Record<string, string>;
}

let installPromise: Promise<void> | null = null;

function getStablePiExtensionInstallRoot(): string {
  return (
    process.env["MANTA_PI_EXTENSION_INSTALL_ROOT"] ||
    join(homedir(), ".manta", "pi-extensions", "npm")
  );
}

function parseNpmExtensionSource(source: string): NpmExtensionSource | null {
  if (!source.startsWith("npm:")) return null;
  const spec = source.slice("npm:".length).trim();
  if (!spec) return null;
  const packageName = (() => {
    if (spec.startsWith("@")) {
      const slash = spec.indexOf("/");
      if (slash === -1) return spec;
      const versionAt = spec.indexOf("@", slash + 1);
      return versionAt === -1 ? spec : spec.slice(0, versionAt);
    }
    const versionAt = spec.indexOf("@");
    return versionAt === -1 ? spec : spec.slice(0, versionAt);
  })();
  return {
    source,
    spec,
    packageName,
    installPath: join(getStablePiExtensionInstallRoot(), "node_modules", ...packageName.split("/")),
  };
}

/** Split an npm install spec into name + optional pinned version. Handles scopes:
 * "@scope/pkg@1.2.3" → { "@scope/pkg", "1.2.3" }; "pkg" → { "pkg", null }. */
export function parsePinnedSpec(spec: string): { name: string; version: string | null } {
  const at = spec.startsWith("@") ? spec.indexOf("@", spec.indexOf("/") + 1) : spec.indexOf("@");
  return at <= 0 ? { name: spec, version: null } : { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

/** The `version` of an installed package dir, or null if absent/unreadable. */
function installedPackageVersion(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    const v = isJsonObject(parsed) ? parsed["version"] : undefined;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Additional sources from the engineer's global Pi settings (`packages` array). */
function getGlobalPiSettingsPackageSources(): string[] {
  const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
  if (!existsSync(settingsPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!isJsonObject(parsed) || !Array.isArray(parsed["packages"])) return [];
    return parsed["packages"].flatMap((entry): string[] => {
      if (typeof entry === "string") return [entry];
      if (isJsonObject(entry) && typeof entry["source"] === "string") return [entry["source"]];
      return [];
    });
  } catch (err) {
    console.warn(`[pi] Could not read Pi settings packages from ${settingsPath}:`, err);
    return [];
  }
}

/** Defaults + global Pi settings + the `MANTA_PI_EXTENSION_PATHS` escape hatch. */
function getConfiguredPiExtensionSources(): string[] {
  const raw = process.env["MANTA_PI_EXTENSION_PATHS"];
  const envSources = raw
    ? raw
        .split(/[\n,]/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
    : [];
  // Package-name collisions are resolved by the last source below. Manta's
  // tested defaults override an engineer's stale global package spec, while the
  // explicit env escape hatch remains the final override for development.
  return [...new Set([...getGlobalPiSettingsPackageSources(), ...DEFAULT_PI_EXTENSION_SOURCES, ...envSources])];
}

/** Resolve duplicate npm package entries with last-one-wins semantics. Exported
 * as a string-only helper so ordering behavior can be tested without exposing
 * installer paths or reading global Pi settings. */
export function resolveNpmExtensionSpecs(sources: readonly string[]): string[] {
  const byPackageName = new Map<string, string>();
  for (const source of sources) {
    const npmSource = parseNpmExtensionSource(source);
    if (npmSource) byPackageName.set(npmSource.packageName, source);
  }
  return [...byPackageName.values()];
}

function getConfiguredNpmExtensionSources(): NpmExtensionSource[] {
  return resolveNpmExtensionSpecs(getConfiguredPiExtensionSources())
    .map((source) => parseNpmExtensionSource(source))
    .filter((source): source is NpmExtensionSource => source !== null);
}

function ensureCachePackageJson(root: string): void {
  mkdirSync(root, { recursive: true });
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    writeFileSync(
      packageJsonPath,
      JSON.stringify({ name: "manta-pi-extensions", private: true }, null, 2),
      "utf-8",
    );
  }
}

function readInstallMetadata(root: string): ExtensionInstallMetadata {
  const metadataPath = join(root, EXTENSION_INSTALL_METADATA_FILE);
  if (!existsSync(metadataPath)) return { npmSpecs: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(metadataPath, "utf-8"));
    if (!isJsonObject(parsed) || !isJsonObject(parsed["npmSpecs"])) return { npmSpecs: {} };
    const npmSpecs: Record<string, string> = {};
    for (const [packageName, spec] of Object.entries(parsed["npmSpecs"])) {
      if (typeof spec === "string") npmSpecs[packageName] = spec;
    }
    return { npmSpecs };
  } catch {
    return { npmSpecs: {} };
  }
}

function writeInstallMetadata(root: string, npmSources: readonly NpmExtensionSource[]): void {
  const metadataPath = join(root, EXTENSION_INSTALL_METADATA_FILE);
  const current = readInstallMetadata(root);
  const npmSpecs = { ...current.npmSpecs };
  for (const source of npmSources) {
    npmSpecs[source.packageName] = source.spec;
  }
  writeFileSync(metadataPath, JSON.stringify({ npmSpecs }, null, 2), "utf-8");
}

function runNpmInstall(root: string, specs: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install", ...specs, "--prefix", root], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      reject(new Error(`npm install exited ${code ?? "unknown"}\n${stdout}\n${stderr}`.trim()));
    });
  });
}

/**
 * Install Manta's Pi extension packages into a stable cache ONCE per process.
 * Memoized: repeat calls return the same promise, so this is safe to await on
 * every turn — but the daemon calls it at startup so the first task never waits
 * on a cold npm install. Best-effort: a failed install logs a warning and clears
 * the memo (so a later call can retry) rather than throwing — the worker still
 * runs with its built-in tools.
 */
export function ensureConfiguredPiExtensionsInstalled(): Promise<void> {
  installPromise ??= (async () => {
    const root = getStablePiExtensionInstallRoot();
    const installMetadata = readInstallMetadata(root);
    const npmSources = getConfiguredNpmExtensionSources();
    const staleOrMissingSources = npmSources.filter(
      (source) => !existsSync(source.installPath) || installMetadata.npmSpecs[source.packageName] !== source.spec,
    );
    const extensionSpecs = staleOrMissingSources.map((source) => source.spec);
    // Reinstall a runtime dep when it's missing OR (for a pinned `name@version`)
    // when the installed version drifted — so an existing box that baked the wrong
    // version (e.g. pi-ai 0.80.x) self-heals to the pin at the next boot's startup,
    // not only on a fresh image build.
    const staleRuntimeDeps = PI_EXTENSION_RUNTIME_DEPENDENCIES.filter((spec) => {
      const { name, version } = parsePinnedSpec(spec);
      const dir = join(root, "node_modules", ...name.split("/"));
      if (!existsSync(dir)) return true;
      return version !== null && installedPackageVersion(dir) !== version;
    });
    const specs = [...new Set([...extensionSpecs, ...staleRuntimeDeps])];
    if (specs.length === 0) return;

    ensureCachePackageJson(root);
    console.log(`[pi] Installing ${specs.length} Pi extension package(s) into ${root}`);
    await runNpmInstall(root, specs);
    writeInstallMetadata(root, npmSources);
    console.log(`[pi] Pi extension packages installed`);
  })().catch((err: unknown) => {
    installPromise = null;
    console.warn("[pi] Pi extension package install failed:", err);
  });
  return installPromise;
}

/**
 * Resolved local paths to hand Pi via `additionalExtensionPaths`. npm: sources
 * map to their dir in the stable cache (populated by
 * ensureConfiguredPiExtensionsInstalled); non-npm sources pass through as-is.
 */
export function getConfiguredPiExtensionPaths(): string[] {
  const npmPaths = getConfiguredNpmExtensionSources().map((source) => source.installPath);
  const localPaths = getConfiguredPiExtensionSources().filter((source) => !parseNpmExtensionSource(source));
  return [...new Set([...npmPaths, ...localPaths])];
}

export function isOpenAICompatibleToolName(name: string): boolean {
  return OPENAI_TOOL_NAME_PATTERN.test(name);
}

/**
 * Tool names registered by the loaded extensions. These must be added to the
 * Pi `tools` allowlist or the extensions' tools stay disabled. Names that OpenAI
 * rejects (e.g. `web.run`) are filtered out — the extension still owns enabling
 * them on the providers that accept them.
 */
export function getExtensionToolNames(resourceLoader: DefaultResourceLoader): string[] {
  const names = new Set<string>();
  for (const extension of resourceLoader.getExtensions().extensions) {
    for (const toolName of extension.tools.keys()) {
      if (isOpenAICompatibleToolName(toolName)) names.add(toolName);
    }
  }
  return [...names];
}

export function logPiExtensionDiagnostics(logTag: string, resourceLoader: DefaultResourceLoader): void {
  const { extensions, errors } = resourceLoader.getExtensions();
  if (extensions.length > 0) {
    console.log(`[${logTag}] Pi extensions enabled: ${extensions.map((extension) => extension.path).join(", ")}`);
  }
  for (const error of errors) {
    console.warn(`[${logTag}] Pi extension load warning: ${error.path}: ${error.error}`);
  }
}

/**
 * Set worker-side env defaults for the Pi extensions. Uses `??=` semantics so an
 * explicit env var always wins. Today only the vision-proxy model: Manta runs on
 * the user's Codex subscription, so route image descriptions through Codex rather
 * than the extension's default (anthropic/claude-sonnet-4-5), which would need a
 * separate Anthropic key.
 */
export function setPiExtensionEnvDefaults(): void {
  process.env["PI_VISION_PROXY_MODEL"] ??= "openai-codex/gpt-5.4";
  const binDir = join(getStablePiExtensionInstallRoot(), "node_modules", ".bin");
  const currentPath = process.env["PATH"] ?? "";
  if (!currentPath.split(":").includes(binDir)) {
    process.env["PATH"] = currentPath ? `${binDir}:${currentPath}` : binDir;
  }
}
