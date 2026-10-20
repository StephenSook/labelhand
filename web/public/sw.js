// Labelhand service worker. It keeps the app usable in a field with no signal: the pages, the
// WebAssembly planner and the label data come from the cache, and the last NWS hourly forecast this
// device fetched for each field is replayed with a header that says when it was saved, so the page
// can label it an offline copy instead of passing it off as live.

const VERSION = "labelhand-v1";
const SHELL = `${VERSION}-shell`;
const FORECASTS = "labelhand-forecasts";
const SHELL_PAGES = ["/app", "/map"];
const SAVED_AT = "x-labelhand-saved-at";
const OFFLINE_COPY = "x-labelhand-offline-copy";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_PAGES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("labelhand-v") && !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isForecast(url) {
  return url.origin === "https://api.weather.gov" && url.pathname.endsWith("/forecast/hourly");
}

async function saveForecast(request, response) {
  const body = await response.clone().arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set(SAVED_AT, new Date().toISOString());
  const cache = await caches.open(FORECASTS);
  await cache.put(request.url, new Response(body, { status: response.status, statusText: response.statusText, headers }));
}

async function forecast(request) {
  try {
    const response = await fetch(request);
    if (response.ok) await saveForecast(request, response);
    return response;
  } catch (error) {
    const cached = await (await caches.open(FORECASTS)).match(request.url);
    if (!cached) throw error;
    const headers = new Headers(cached.headers);
    headers.set(OFFLINE_COPY, cached.headers.get(SAVED_AT) ?? "");
    headers.set("access-control-expose-headers", OFFLINE_COPY);
    return new Response(await cached.arrayBuffer(), { status: 200, headers });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function networkFirst(request, fallbackPath) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) ?? (await cache.match(request, { ignoreSearch: true }));
    if (cached) return cached;
    if (fallbackPath) {
      const fallback = await cache.match(fallbackPath);
      if (fallback) return fallback;
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isForecast(url)) {
    event.respondWith(forecast(request));
    return;
  }
  if (url.origin !== self.location.origin) return;
  // Live label compiles, photo reads, the season API and the agent always need the network.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/app"));
    return;
  }
  event.respondWith(networkFirst(request));
});

// The page that registered this worker loaded its scripts, data and forecasts before the worker
// controlled it, so it sends their URLs once and the worker stores them for the first offline visit.
self.addEventListener("message", (event) => {
  if (event.data?.type !== "warm" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(
    Promise.all(
      event.data.urls.map(async (href) => {
        try {
          const url = new URL(href);
          if (isForecast(url)) {
            const response = await fetch(url.href, { mode: "cors" });
            if (response.ok) await saveForecast(new Request(url.href), response);
            return;
          }
          if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
          const cache = await caches.open(SHELL);
          if (!(await cache.match(url.href))) await cache.add(url.href);
        } catch {
          // A resource that cannot be stored now is stored the next time the page loads it.
        }
      }),
    ),
  );
});
