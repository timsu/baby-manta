interface WorkerHandoffTask {
  id: string;
  title: string;
  repo: string;
  linearIssueIdentifier?: string | null;
  prUrl?: string | null;
}

export function workerHandoffBody(task: WorkerHandoffTask, message: string): string {
  return [
    `[Worker handoff from task ${task.id} ("${task.title}") in ${task.repo}]`,
    task.linearIssueIdentifier ? `Linked Linear issue: ${task.linearIssueIdentifier}` : undefined,
    task.prUrl ? `Linked PR: ${task.prUrl}` : undefined,
    "The worker is requesting orchestration help. Use brain tools as appropriate (for example create_task for follow-up fix cards, list_linear_members + assign_linear_issue for engineer handoff, or comment_on_linear_issue for Linear updates). If requested Linear issue creation is unavailable or fails, call create_task with cardType investigation and no Linear identifier so the work is not dropped.",
    "",
    message,
  ].filter((line): line is string => line !== undefined).join("\n");
}
