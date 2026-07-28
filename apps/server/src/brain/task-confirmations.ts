import type { CreatedTaskSummary } from "@manta/agent";

function taskIntro(task: CreatedTaskSummary): string {
  if (task.reusedExisting) return "Reusing existing worker card";
  if (task.cardStatus === "bot_working" || task.cardStatus === "interactive") return "Started worker card";
  if (task.cardStatus === "backlog") return "Created backlog card";
  return "Created card";
}

function taskRef(task: CreatedTaskSummary): string {
  return task.taskNumber ? `#${task.taskNumber} (${task.id})` : task.id;
}

/** Build a deterministic reply for task-creation turns from canonical task data,
 * so Slack/Linear confirmations never mention a repo the tool did not return. */
export function taskCreationConfirmation(tasks: readonly CreatedTaskSummary[]): string | null {
  if (tasks.length === 0) return null;
  if (tasks.length === 1) {
    const task = tasks[0]!;
    return `${taskIntro(task)} ${taskRef(task)} in ${task.repo}: ${task.title}`;
  }
  const hasReused = tasks.some((task) => task.reusedExisting);
  return [
    hasReused ? `Handled ${tasks.length} cards:` : `Created ${tasks.length} cards:`,
    ...tasks.map((task) => hasReused
      ? `- ${task.reusedExisting ? "Reusing existing" : "Created"} ${taskRef(task)} in ${task.repo}: ${task.title}`
      : `- ${taskRef(task)} in ${task.repo}: ${task.title}`),
  ].join("\n");
}
