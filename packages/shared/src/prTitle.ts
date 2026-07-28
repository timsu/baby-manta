function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ensure PR titles include the linked Linear issue identifier so Linear's
 * GitHub integration can automatically associate the PR with the issue.
 */
export function formatPrTitleWithLinearIssue(title: string, linearIssueIdentifier?: string | null): string {
  const trimmedTitle = title.trim();
  const identifier = linearIssueIdentifier?.trim();
  if (!identifier) return trimmedTitle;
  if (!trimmedTitle) return identifier;

  const identifierPattern = new RegExp(`(^|[^A-Z0-9])${escapeRegExp(identifier)}(?=$|[^A-Z0-9])`, "i");
  if (identifierPattern.test(trimmedTitle)) return trimmedTitle;

  return `${identifier}: ${trimmedTitle}`;
}
