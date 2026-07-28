import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

let cachedGitHash: string | null | undefined;

function shortHash(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 10);
}

export async function getGitHash(cwd = process.cwd()): Promise<string | null> {
  if (cachedGitHash !== undefined) return cachedGitHash;

  const envHash = process.env["MANTA_GIT_HASH"] ?? process.env["GIT_SHA"] ?? process.env["GITHUB_SHA"];
  const fromEnv = envHash ? shortHash(envHash) : null;
  if (fromEnv) {
    cachedGitHash = fromEnv;
    return cachedGitHash;
  }

  try {
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--short=10", "HEAD"]);
    cachedGitHash = shortHash(stdout);
  } catch {
    cachedGitHash = null;
  }
  return cachedGitHash;
}
