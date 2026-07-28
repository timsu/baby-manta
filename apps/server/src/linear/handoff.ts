export type LinearHandoffTask = {
  id: string;
  title: string;
  repo: string;
  prUrl: string | null;
  doneReason: string | null;
};

export function linearHandoffCommentBody(task: LinearHandoffTask): string {
  const card = `Manta card "${task.title}" (${task.id}, ${task.repo})`;
  if (task.prUrl) {
    const status = task.doneReason === "merged"
      ? "was marked done after its PR merged"
      : "is marked done with a linked PR";
    return `${card} ${status}: ${task.prUrl}`;
  }
  return `${card} is marked done in Manta.`;
}

