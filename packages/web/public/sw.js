// ORC service worker: offline app shell, immutable asset cache and Web Push.
// API, MCP and WebSocket traffic is never intercepted — it always goes to the network.
const SHELL_CACHE = "orc-shell-v1";
const ASSET_CACHE = "orc-assets-v1";
const CACHES = [SHELL_CACHE, ASSET_CACHE];
const MAX_ASSETS = 200;
const NAVIGATION_TIMEOUT_MS = 4000;
const BYPASS_PREFIXES = ["/api/", "/mcp", "/docs", "/openapi.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.add(new Request("/", { cache: "no-cache" })))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (!CACHES.includes(name)) await caches.delete(name);
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

function cacheableShell(response) {
  return (
    response.ok &&
    !response.redirected &&
    response.type === "basic" &&
    (response.headers.get("content-type") ?? "").includes("text/html")
  );
}

async function trimAssets(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

async function navigate(event) {
  const network = (async () => {
    const response = (await event.preloadResponse) ?? (await fetch(event.request));
    if (cacheableShell(response)) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put("/", response.clone());
    }
    return response;
  })();
  const timeout = new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS));
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch {}
  const cached = await caches.match("/", { cacheName: SHELL_CACHE });
  // Slow network and nothing cached yet: keep waiting for the real response.
  return cached ?? network;
}

async function asset(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    await cache.put(request, response.clone());
    void trimAssets(cache);
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;
  if (request.mode === "navigate") event.respondWith(navigate(event));
  else if (url.pathname.startsWith("/assets/")) event.respondWith(asset(request));
});

self.addEventListener("push", (event) => {
  let message = { title: "ORC", body: "", url: "/", tag: "orc" };
  try {
    message = { ...message, ...event.data?.json() };
  } catch {}
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // The open, focused app already shows this live; only notify when the user is elsewhere.
      if (windows.some((client) => client.focused && client.visibilityState === "visible")) return;
      await self.registration.showNotification(message.title, {
        body: message.body,
        tag: message.tag,
        renotify: true,
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        data: { url: message.url },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = windows.find((candidate) => new URL(candidate.url).origin === target.origin);
      if (client) {
        await client.focus();
        await client.navigate(target.href).catch(() => {});
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
