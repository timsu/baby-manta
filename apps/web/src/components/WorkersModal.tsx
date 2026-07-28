import { useCallback, useEffect, useState } from "react";
import { api, type WorkerInfo, type SandboxInfo } from "../api.ts";
import { openTask } from "../ws.ts";
import { selectWorkspace } from "../actions.ts";
import { $activeWorkspaceId } from "../stores.ts";
import { Modal } from "./ui.tsx";

// ─────────────────────────── workers ────────────────────────────

export function WorkersModal({ onClose }: { onClose: () => void }) {
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const [sandboxes, setSandboxes] = useState<SandboxInfo[]>([]);
  const [serverGitHash, setServerGitHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [workerScope, setWorkerScope] = useState<"mine" | "team">("mine");
  const [updatingWorkerIds, setUpdatingWorkerIds] = useState<Set<string>>(() => new Set());
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());
  const [removingIds, setRemovingIds] = useState<Set<string>>(() => new Set());
  const [movingIds, setMovingIds] = useState<Set<string>>(() => new Set());
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ workers: ws, serverGitHash: serverHash }, { sandboxes: sbs }] = await Promise.all([
        api.listWorkers(workerScope),
        api.listSandboxes().catch(() => ({ sandboxes: [] as SandboxInfo[] })),
      ]);
      setWorkers(ws);
      setServerGitHash(serverHash);
      setSandboxes(sbs);
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [workerScope]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const interval = setInterval(() => void refresh(), 4000);
    return () => clearInterval(interval);
  }, [refresh]);

  const age = (iso: string) => {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  };

  const stopSandbox = async (sb: SandboxInfo) => {
    setStoppingIds((prev) => new Set(prev).add(sb.id));
    try {
      await api.stopSandbox(sb.taskId, sb.workspaceId);
      void refresh();
    } catch (err) {
      console.error("Stop sandbox failed", err);
    } finally {
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.delete(sb.id);
        return next;
      });
    }
  };

  const removeSandbox = async (sb: SandboxInfo) => {
    // Removing a running box kills active work — confirm first. A stopped box is
    // inert, so delete it without the prompt.
    const running = sb.state === "started" || sb.state == null;
    if (running && !confirm(`"${sb.task?.title ?? sb.taskId}" is still running. Remove its sandbox and discard any uncommitted work?`)) return;
    setRemovingIds((prev) => new Set(prev).add(sb.id));
    try {
      await api.removeSandbox(sb.taskId, sb.workspaceId);
      void refresh();
    } catch (err) {
      console.error("Remove sandbox failed", err);
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(sb.id);
        return next;
      });
    }
  };

  const moveToLocal = async (sb: SandboxInfo) => {
    setMoveError(null);
    setMovingIds((prev) => new Set(prev).add(sb.id));
    try {
      await api.moveSandboxToLocal(sb.taskId, sb.workspaceId);
      void refresh();
    } catch (err) {
      const code = err instanceof Error ? err.message : "";
      setMoveError(
        /no_local_worker|no_owner/.test(code)
          ? "No connected local worker to move this task to — start your worker, then try again."
          : code === "stop_failed"
            ? "Couldn't stop the cloud sandbox — try again, or Stop it manually first."
            : `Move to local failed: ${code || "unknown error"}`,
      );
    } finally {
      setMovingIds((prev) => {
        const next = new Set(prev);
        next.delete(sb.id);
        return next;
      });
    }
  };

  const openSandboxTask = async (sb: SandboxInfo) => {
    // A sandbox may belong to a different workspace than the one in view; switch
    // to its workspace first (re-points the ws subscription) so the task detail
    // streams correctly instead of 404ing against the active workspace. A failed
    // switch must not become an unhandled rejection (this runs via `void`).
    try {
      if (sb.workspaceId !== $activeWorkspaceId.get()) await selectWorkspace(sb.workspaceId);
      openTask(sb.taskId);
      onClose();
    } catch (err) {
      console.error("open sandbox task failed", err);
    }
  };

  const requestUpdate = async (workerId: string) => {
    setUpdateError(null);
    setUpdatingWorkerIds((prev) => new Set(prev).add(workerId));
    try {
      await api.updateWorker(workerId);
      void refresh();
    } catch (err) {
      console.error("Worker update request failed", err);
      setUpdateError(err instanceof Error ? err.message : "Failed to update worker");
    } finally {
      setUpdatingWorkerIds((prev) => {
        const next = new Set(prev);
        next.delete(workerId);
        return next;
      });
    }
  };

  return (
    <Modal title="Workers" onClose={onClose}>
      <div className="worker-panel-toolbar">
        <div className="board-mode-toggle" aria-label="Worker scope">
          <button className={`seg ${workerScope === "mine" ? "on" : ""}`} onClick={() => setWorkerScope("mine")}>Mine</button>
          <button className={`seg ${workerScope === "team" ? "on" : ""}`} onClick={() => setWorkerScope("team")}>Team</button>
        </div>
      </div>
      {loading && <p className="muted">Loading…</p>}
      {!loading && workerScope === "mine" && workers.filter((w) => w.live).length === 0 && (
        <div className="worker-setup">
          <p className="muted">No workers connected. To set up a local worker:</p>
          <pre><code>{`git clone https://github.com/acme/manta.git
cd manta
./start-worker`}</code></pre>
          <p className="muted small">On first start, it asks whether to run automatically at login.</p>
        </div>
      )}
      {!loading && workerScope === "team" && workers.filter((w) => w.live).length === 0 && (
        <p className="muted">No team workers connected.</p>
      )}
      {updateError && <p className="muted small">Update failed: {updateError}</p>}
      {workers.map((w) => {
        const workerHash = w.gitHash ?? "unknown";
        const updateAvailable = Boolean(w.gitHash && serverGitHash && w.gitHash !== serverGitHash);
        const running = w.activeTasks.map((task) => task.title).join(", ") || w.activeTaskIds.join(", ");
        const ownerLabel = w.owner ? (w.owner.name || w.owner.email) : null;
        return (
          <div key={w.workerId} className="worker-row">
            <span className={`worker-dot ${!w.live ? "offline" : w.idle ? "idle" : "busy"}`} />
            <div className="worker-info">
              <div className="worker-id">{w.workerId}</div>
              <div className="worker-meta muted small">
                {workerScope === "team" && ownerLabel && <>{ownerLabel} · </>}
                {!w.live ? "reconnecting" : w.idle ? "ready" : `running ${w.activeTaskCount}: ${running}`}
                {" · "}accepts multiple tasks
                {" · "}{w.live ? "connected" : "last seen"} {age(w.connectedAt)}
                {" · "}worker {workerHash}
                {serverGitHash && <> · server {serverGitHash}</>}
              </div>
            </div>
            {w.live && updateAvailable && w.ownerUserId && workerScope === "mine" && (
              <button
                className="btn small worker-update-btn"
                disabled={updatingWorkerIds.has(w.workerId)}
                onClick={() => void requestUpdate(w.workerId)}
              >
                {updatingWorkerIds.has(w.workerId) ? "Updating…" : "Update"}
              </button>
            )}
          </div>
        );
      })}

      {sandboxes.length > 0 && (
        <>
          <div className="worker-section-label muted small">Cloud sandboxes</div>
          {moveError && <p className="muted small">{moveError}</p>}
          {sandboxes.map((sb) => {
            const running = sb.state === "started" || sb.state == null;
            return (
              <div key={sb.id} className="worker-row">
                <span className={`worker-dot ${running ? "online" : "offline"}`} />
                <div className="worker-info worker-info-clickable" onClick={() => void openSandboxTask(sb)}>
                  <div className="worker-id">{sb.task?.title ?? sb.taskId}</div>
                  <div className="worker-meta muted small">
                    {sb.state ?? "unknown"}
                    {sb.createdAt && <> · started {age(sb.createdAt)}</>}
                    {" · "}{sb.id.slice(0, 8)}
                  </div>
                </div>
                <div className="worker-row-actions">
                  {workers.some((w) => w.live) && (
                    <button
                      className="btn small"
                      disabled={movingIds.has(sb.id)}
                      onClick={() => void moveToLocal(sb)}
                      title="Stop the cloud sandbox and re-run this task on a local worker"
                    >
                      {movingIds.has(sb.id) ? "Moving…" : "Move to local"}
                    </button>
                  )}
                  {running && (
                    <button
                      className="btn small"
                      disabled={stoppingIds.has(sb.id)}
                      onClick={() => void stopSandbox(sb)}
                    >
                      {stoppingIds.has(sb.id) ? "Stopping…" : "Stop"}
                    </button>
                  )}
                  <button
                    className="btn small ghost muted"
                    disabled={removingIds.has(sb.id)}
                    onClick={() => void removeSandbox(sb)}
                    title="Delete this sandbox permanently"
                  >
                    {removingIds.has(sb.id) ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>
            );
          })}
        </>
      )}
    </Modal>
  );
}
