const CACHE_NAME = "assetflow-invest-v273";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./logic.js",
  "./logic-init.js",
  "./vendor/fflate-0.8.2.min.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  // 用 no-store 預載，避免從瀏覽器 HTTP 快取（GitHub Pages max-age=600）抓到舊殼層檔
  event.waitUntil(caches.open(CACHE_NAME).then((cache) =>
    Promise.all(ASSETS.map((url) =>
      fetch(url, { cache: "no-store" })
        .then((res) => res.ok ? cache.put(url, res) : null)
        .catch(() => null)
    ))
  ));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // 自家殼層檔（導覽 / html / js / css）繞過 HTTP 快取，確保每次連線都拿最新版本；
  // 跨網域（Google API、報價 proxy、OCR CDN）維持預設，避免破壞其快取與 opaque 回應。
  const isAppShell = url.origin === self.location.origin
    && (event.request.mode === "navigate" || /\.(?:html|js|css)$/.test(url.pathname) || url.pathname.endsWith("/"));
  event.respondWith(networkFirst(event.request, isAppShell));
});

async function networkFirst(request, bypassHttpCache) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = bypassHttpCache
      ? await fetch(request.url, { cache: "no-store" })
      : await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}
