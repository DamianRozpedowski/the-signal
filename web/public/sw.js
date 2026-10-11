// Service worker used only for Web Push notifications (no offline caching).
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "The Signal", body: event.data && event.data.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || "The Signal", { body: data.body || "", data: { url: data.url || "/" }, icon: "/favicon.svg" }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(clients.matchAll({ type: "window" }).then((list) => {
    for (const c of list) if ("focus" in c) { c.navigate(url); return c.focus(); }
    return clients.openWindow(url);
  }));
});
