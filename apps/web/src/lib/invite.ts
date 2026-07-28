import { api } from "../api.ts";
import { loadMe, selectWorkspace } from "../actions.ts";

// ─────────────────────────── invites ───────────────────────────

const INVITE_KEY = "manta:pending-invite";

// Read an invite code from ?invite=… (then strip it from the URL) or from a
// prior visit persisted to localStorage so it survives the OAuth round-trip.
export function captureInviteCode(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("invite");
    if (fromUrl) {
      localStorage.setItem(INVITE_KEY, fromUrl);
      url.searchParams.delete("invite");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      return fromUrl;
    }
  } catch { /* ignore malformed URL */ }
  return localStorage.getItem(INVITE_KEY);
}

export function clearInviteCode() {
  localStorage.removeItem(INVITE_KEY);
}

// Accept either a bare code or a full invite URL pasted into the join field.
export function parseInviteInput(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const code = new URL(s).searchParams.get("invite");
    if (code) return code;
  } catch { /* not a URL — treat as a bare code */ }
  return s;
}

export async function acceptInviteAndEnter(code: string): Promise<void> {
  const { workspaceId } = await api.acceptInvitation(code);
  clearInviteCode();
  await loadMe();
  await selectWorkspace(workspaceId);
}
