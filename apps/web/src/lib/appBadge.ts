const unreadTaskIds = new Set<string>();

type BadgingNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function isAppVisible() {
  return document.visibilityState === "visible" && document.hasFocus();
}

async function clearDeliveredNotifications() {
  if (!("serviceWorker" in navigator)) return;
  try {
    navigator.serviceWorker.controller?.postMessage({ type: "clear_notifications" });
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({ type: "clear_notifications" });
  } catch {
    // Best effort only; the badge state is still cleared below.
  }
}

async function applyBadge() {
  const nav = navigator as BadgingNavigator;
  try {
    if (unreadTaskIds.size === 0) await nav.clearAppBadge?.();
    else await nav.setAppBadge?.(unreadTaskIds.size);
  } catch {
    // Browsers may reject when badging is unavailable for this install mode.
  }
}

export function clearAppNotifications() {
  unreadTaskIds.clear();
  void applyBadge();
  void clearDeliveredNotifications();
}

export function clearTaskNotification(taskId: string) {
  if (!unreadTaskIds.delete(taskId)) return;
  void applyBadge();
}

export function noteTaskNotification(taskId: string) {
  if (isAppVisible()) {
    clearAppNotifications();
    return;
  }
  unreadTaskIds.add(taskId);
  void applyBadge();
}

export function installAppNotificationClearing() {
  const clearIfVisible = () => {
    if (isAppVisible()) clearAppNotifications();
  };
  window.addEventListener("focus", clearIfVisible);
  document.addEventListener("visibilitychange", clearIfVisible);
  window.addEventListener("pageshow", clearIfVisible);
  clearIfVisible();
  return () => {
    window.removeEventListener("focus", clearIfVisible);
    document.removeEventListener("visibilitychange", clearIfVisible);
    window.removeEventListener("pageshow", clearIfVisible);
  };
}

export function getUnreadNotificationCountForTest() {
  return unreadTaskIds.size;
}
