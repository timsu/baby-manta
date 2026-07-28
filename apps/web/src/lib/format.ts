export function repoShort(orgRepo: string): string {
  return orgRepo.split("/").pop() ?? orgRepo;
}

export function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

export function taskDisplayId(c: { repo: string; taskNumber: number | null; id: string }): string {
  if (c.taskNumber != null) return `${repoShort(c.repo)}-${c.taskNumber}`;
  return shortTaskId(c.id);
}
