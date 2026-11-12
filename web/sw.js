/* Everything needed to scan is cached here; camera frames never pass through it. */
const VERSION = "1.3.0";
const FEATURES = ["code128-lab"];
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = `barcode-camera:${SCOPE.href}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const CORE_PATHS = [
  "./", "./index.html", "./styles.css", "./scan-policy.js", "./app.js", "./scanner-worker.js",
  "./vendor/zxing-reader.js", "./vendor/zxing_reader.wasm",
  "./vendor/public-sans-latin.woff2", "./manifest.webmanifest",
  "./icon.svg", "./icon-192.png", "./icon-512.png",
  "./vendor/THIRD-PARTY.txt", "./vendor/ZXING-WASM-LICENSE.txt",
  "./vendor/ZXING-CPP-LICENSE.txt", "./vendor/ZXING-WASM-CPP-LICENSE.txt",
  "./vendor/PUBLIC-SANS-LICENSE.txt",
  "./lab/", "./lab/index.html", "./lab/lab.css", "./lab/lab.js", "./lab/lab-policy.js",
  "./code128-lab-worker.js", "./engine/code128-decoder.js", "./engine/code128-detector.js",
  "./engine/code128-engine.js", "./engine/THIRD-PARTY.txt",
];
const CORE_URLS = CORE_PATHS.map(path => new URL(path, SCOPE).href);
const CORE_SET = new Set(CORE_URLS);
const SHELL_URL = new URL("./index.html", SCOPE).href;

async function isOfflineReady() {
  const cache = await caches.open(CACHE_NAME);
  const assets = await Promise.all(CORE_URLS.map(url => cache.match(url)));
  return assets.every(response => response && response.ok);
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll commits its batch only if every asset downloads successfully.
    // reload bypasses the HTTP cache, so a new version gets a matching shell/engine.
    await cache.addAll(CORE_URLS.map(url => new Request(url, { cache: "reload" })));
    if (!await isOfflineReady()) throw new Error("Offline app download is incomplete.");
    // An existing app keeps its current version until the user accepts the update.
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    if (!await isOfflineReady()) throw new Error("Offline app download is incomplete.");
    const names = await caches.keys();
    await Promise.all(names
      .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", event => {
  if (event.data?.type === "OFFLINE_STATUS") {
    event.waitUntil((async () => {
      let ready = false;
      try { ready = await isOfflineReady(); } catch { /* Storage may be unavailable. */ }
      event.ports?.[0]?.postMessage({ ready, version: VERSION, features: FEATURES });
    })());
  } else if (event.data?.type === "REPAIR_OFFLINE") {
    event.waitUntil((async () => {
      let ready = false;
      let error;
      try {
        const cache = await caches.open(CACHE_NAME);
        // addAll is atomic: a failed repair preserves every previously usable file.
        await cache.addAll(CORE_URLS.map(url => new Request(url, { cache: "reload" })));
        ready = await isOfflineReady();
        if (!ready) error = "Some offline files are still missing. Please try again.";
      } catch {
        try { ready = await isOfflineReady(); } catch { /* Storage may be unavailable. */ }
        error = "Could not download all offline files. Connect to the internet and try again.";
      }
      event.ports?.[0]?.postMessage({ ready, version: VERSION, features: FEATURES, ...(error ? { error } : {}) });
    })());
  } else if (event.data?.type === "ACTIVATE_UPDATE") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== SCOPE.origin) return;
  if (!url.pathname.startsWith(SCOPE.pathname)) return;
  // The API is never part of this offline cache, including when served at root.
  if (url.pathname.includes("/v1/") || url.pathname.endsWith("/v1")) return;
  url.search = "";
  url.hash = "";

  if (request.mode === "navigate" && (url.href === SCOPE.href || url.href === SHELL_URL)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const shell = await cache.match(SHELL_URL);
      if (shell) return shell;
      return fetch(request);
    })());
    return;
  }
  if (!CORE_SET.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const saved = await cache.match(url.href);
    if (saved) return saved;
    const response = await fetch(request);
    if (response.ok && response.type !== "opaque") {
      await cache.put(url.href, response.clone());
    }
    return response;
  })());
});
