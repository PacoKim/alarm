// 앱 껍데기만 캐시한다. API 응답은 항상 네트워크에서 받아 최신 일정을 보장한다.
const CACHE = "family-reminder-v2";
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
