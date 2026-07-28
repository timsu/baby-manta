import type { AgentEvent, AskQuestion } from "@manta/shared";
import type { TaskTranscriptEntry } from "../worker/snapshot.ts";

/** Per-task accumulator for messages streaming from an external worker. */
export interface TaskAccum {
  workspaceId: string;
  assistantText: string;
  toolTrace: Array<{ tool: string; args: string }>;
  transcript: TaskTranscriptEntry[];
}

export const taskAccums = new Map<string, TaskAccum>();

/** LRU event buffer: holds in-flight events per task so clients can replay on re-subscribe. */
export const taskEventBuffers = new Map<string, AgentEvent[]>();
const TASK_BUFFER_MAX = 100;
/** Cap events retained per task; a long-running turn can stream thousands. */
export const TASK_EVENTS_MAX = 500;

export function pushTaskEventBuffer(taskId: string, event: AgentEvent): void {
  let buf = taskEventBuffers.get(taskId);
  if (buf) {
    // Refresh insertion order so eviction removes the least recently updated task.
    taskEventBuffers.delete(taskId);
    taskEventBuffers.set(taskId, buf);
  } else {
    if (taskEventBuffers.size >= TASK_BUFFER_MAX) {
      taskEventBuffers.delete(taskEventBuffers.keys().next().value!);
    }
    buf = [];
    taskEventBuffers.set(taskId, buf);
  }
  buf.push(event);
  // Keep only the most recent events so a long stream can't grow without bound.
  if (buf.length > TASK_EVENTS_MAX) buf.splice(0, buf.length - TASK_EVENTS_MAX);
}

/** Live terminal relay sessions, keyed by sessionId. The PTY lives on the worker;
 * the server just shuttles frames between the browser WS and the worker WS. */
export interface TerminalRelaySession {
  send: (s: string) => void;
  close: (code?: number, reason?: string) => void;
  taskId: string;
  workerId: string;
}

export const terminalSessions = new Map<string, TerminalRelaySession>();

export interface PendingUserQuestion {
  workspaceId: string;
  taskId: string;
  /** User who owns the task/card. Ownerless automation tasks are visible to any workspace member. */
  ownerUserId: string | null;
  questionId: string;
  questions: AskQuestion[];
  answer: (answer: string) => boolean;
}

/** In-flight ask_user_question prompts, retained independently of whether the
 * card detail pane is open. Cleared when the browser answers. */
export const pendingUserQuestions = new Map<string, PendingUserQuestion>();
