type GitExecError = Error & { stderr?: unknown };

/** Git uses different wording across versions when a branch is registered to
 * another worktree. Keep the force retry limited to that one recoverable case. */
export function isBranchAlreadyCheckedOutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const stderr = typeof (error as GitExecError).stderr === "string"
    ? (error as GitExecError).stderr
    : "";
  const output = `${error.message}\n${stderr}`;
  return /already (?:checked out|used by worktree) at /i.test(output);
}
