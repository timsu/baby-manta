// Minimal service worker — enables PWA installability.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));
self.addEventListener("message", (e) => {
  if (e.data?.type !== "clear_notifications") return;
  e.waitUntil(self.registration.getNotifications().then((notifications) => {
    for (const notification of notifications) notification.close();
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => "focus" in client);
    if (existing) return existing.focus();
    if (clients.openWindow) return clients.openWindow("/");
  })());
});
