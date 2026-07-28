export function prFieldsForReport(
  reportedPrTitle: string,
): { title: string; prTitle: string } | null {
  const prTitle = reportedPrTitle.trim();
  if (!prTitle) return null;
  return {
    title: prTitle,
    prTitle,
  };
}
