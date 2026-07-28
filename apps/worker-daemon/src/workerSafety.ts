export const WORKER_SAFETY_INSTRUCTIONS = [
  "SAFETY: Work ONLY inside the worktree — never modify files outside it.",
  "Never run: rm -rf, dropdb, truncate, drop table, sudo, curl | sh.",
  "Never use an unguarded force push (`git push --force` or `git push -f`). `git push --force-with-lease` is allowed when history was intentionally rewritten, after fetching and verifying the remote branch tip.",
] as const;
