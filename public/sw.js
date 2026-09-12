// 앱 껍데기만 캐시한다. API 응답은 항상 네트워크에서 받아 최신 일정을 보장한다.
const CACHE = "family-reminder-v3";
const SHELL = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/nlp.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // API는 캐시하지 않음

  e.respondWith(
    (async () => {
      try {
        const fresh = await fetch(e.request);
        if (fresh.ok) (await caches.open(CACHE)).put(e.request, fresh.clone());
        return fresh;
      } catch {
        const hit = await caches.match(e.request);
        return hit ?? caches.match("/index.html");
      }
    })(),
  );
});

/* ------------------------------ 푸시 알림 ------------------------------ */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "우리가족 알림", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "우리가족 알림";
  const options = {
    body: data.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    // 같은 tag 면 이전 알림을 덮어써 목록이 지저분해지지 않는다
    tag: data.tag || "family-reminder",
    renotify: false,
    data: { url: data.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // 이미 열린 창이 있으면 그 창을 앞으로 가져온다
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && "focus" in client) {
          await client.focus();
          if ("navigate" in client && client.url !== target) await client.navigate(target);
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
