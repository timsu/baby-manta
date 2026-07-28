import { isTransitionAllowed, type CardTransition } from "@manta/shared";
import { prisma, tasks, type Task } from "@manta/db";

export class SwitchRepoError extends Error {
  constructor(readonly code: string, message = code) {
    super(message);
    this.name = "SwitchRepoError";
  }
}

function replacementStatus(task: Task): Task["cardStatus"] {
  if (task.cardStatus === "interactive") return "interactive";
  if (task.cardStatus === "backlog") return "backlog";
  return "bot_working";
}

export async function recreateTaskInRepo(input: {
  workspaceId: string;
  taskId: string;
  targetRepo: string;
  reason: string;
}): Promise<Task> {
  const at = new Date();
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { id: input.taskId, workspaceId: input.workspaceId } });
    if (!task) throw new SwitchRepoError("task_not_found");
    if (task.cardStatus === "canceled") throw new SwitchRepoError("task_already_canceled");
    const target = await tx.repo.findUnique({ where: { workspaceId_orgRepo: { workspaceId: input.workspaceId, orgRepo: input.targetRepo } } });
    if (!target?.enabled) throw new SwitchRepoError("target_repo_not_enabled");
    // Normally the target repo differs from the task's recorded repo. However,
    // cards can get stuck when the worker is running in a checkout that does not
    // match the DB's recorded repo; in that state the model correctly asks to
    // switch to the recorded repo and the old guard rejected it as a no-op. Let
    // the replacement path run for same-repo targets too so a fresh card gets a
    // fresh, correctly provisioned worker instead of forcing Needs Help.
    if (task.prNumber || task.prUrl) throw new SwitchRepoError("cannot_switch_repo_after_pr_reported");
    if (!isTransitionAllowed(task.cardStatus, "canceled", "brain")) throw new SwitchRepoError("cannot_cancel_original_task");

    const taskNumber = await tx.task.count({ where: { workspaceId: input.workspaceId, repo: target.orgRepo } }) + 1;
    const replacement = await tx.task.create({
      data: {
        id: tasks.newTaskId(),
        workspaceId: input.workspaceId,
        name: task.name,
        title: task.title,
        description: task.description,
        kind: task.kind,
        cardType: task.cardType,
        cardStatus: replacementStatus(task),
        repo: target.orgRepo,
        workerBackend: task.workerBackend,
        taskNumber,
        ...(task.model ? { model: task.model } : {}),
        ...(task.type ? { type: task.type } : {}),
        ...(task.createdBy ? { createdBy: task.createdBy } : {}),
        ...(task.linearIssueIdentifier ? { linearIssueIdentifier: task.linearIssueIdentifier } : {}),
        ...(task.slackChannel ? { slackChannel: task.slackChannel } : {}),
        ...(task.slackThreadTs ? { slackThreadTs: task.slackThreadTs } : {}),
        ...(task.slackUserId ? { slackUserId: task.slackUserId } : {}),
        ...(task.slackBotId ? { slackBotId: task.slackBotId } : {}),
      },
    });

    const transition: CardTransition = {
      from: task.cardStatus,
      to: "canceled",
      at: at.toISOString(),
      by: "brain",
      reason: `${target.orgRepo === task.repo ? "Refreshed" : "Recreated"} as ${replacement.id} in ${target.orgRepo}: ${input.reason}`,
    };
    const transitions = Array.isArray(task.transitions)
      ? (task.transitions as unknown as CardTransition[])
      : [];
    await tx.taskTransition.create({
      data: {
        taskId: task.id,
        workspaceId: input.workspaceId,
        fromStatus: task.cardStatus,
        toStatus: "canceled",
        by: "brain",
        reason: transition.reason,
        at,
      },
    });
    await tx.task.update({
      where: { id: task.id },
      data: {
        cardStatus: "canceled",
        workerActive: false,
        workerStatus: "stalled",
        transitions: [...transitions, transition] as unknown as object[],
      },
    });

    return replacement;
  });
}
