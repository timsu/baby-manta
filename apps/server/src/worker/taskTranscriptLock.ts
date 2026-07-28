/**
 * Serialize transcript mutations for one task within this server process.
 * Worker events, disconnect flushes, and user follow-ups can arrive on
 * different sockets at the same time but must assign durable message order in
 * the same sequence in which Manta handles them.
 */
const taskTranscriptTails = new Map<string, Promise<void>>();

export async function withTaskTranscriptLock<T>(taskId: string, action: () => Promise<T>): Promise<T> {
  const previous = taskTranscriptTails.get(taskId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  taskTranscriptTails.set(taskId, current);

  await previous;
  try {
    return await action();
  } finally {
    release();
    if (taskTranscriptTails.get(taskId) === current) taskTranscriptTails.delete(taskId);
  }
}
