// Constructs the active Sandboxes driver. Production uses Daytona (requires
// DAYTONA_API_KEY); tests inject FakeSandboxes directly and never call this.
//
// Memoized so the whole server shares one Daytona client (and its connection
// pool). The driver is created lazily on first use so importing this module —
// or running a deployment that never spawns a cloud worker — never requires
// DAYTONA_API_KEY to be present.

import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { Sandboxes } from "./sandboxes.ts";
import { DaytonaSandboxes } from "./daytona.ts";

const logger = createLogger("Manta:Sandbox");

let cached: Sandboxes | null = null;

/** The shared Daytona-backed Sandboxes driver (memoized). Throws if
 * DAYTONA_API_KEY is unset — only call this on the cloud-venue path. */
export function getSandboxes(): Sandboxes {
  if (!cached) {
    cached = new DaytonaSandboxes(config.daytonaApiKey(), config.daytonaApiUrl() || undefined);
    logger.info("daytona sandboxes initialized", { snapshot: config.sandboxSnapshot() || "(none)" });
  }
  return cached;
}

/** Test seam: install a fake (or null to reset). */
export function setSandboxes(impl: Sandboxes | null): void {
  cached = impl;
}
