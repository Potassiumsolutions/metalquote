// MetalQuote service worker (customer PWA only).
//
// Strategy: NETWORK-FIRST for the app shell, cache only as an offline fallback.
// This tool quotes money, so a stale build is a real hazard: the Worker's prices update
// independently of the client, and an old app.js can render a breakdown that disagrees with
// the total it was given. Correctness beats the few ms a cache-first hit would save.
//
// It was cache-first with a hard-coded cache name, which meant a customer who loaded the tool
// once kept that exact app.js forever — `install` (the only thing that refills the cache) only
// re-runs when THIS file changes bytes, so shipping a new app.js never reached them.
//
// CACHE is stamped with a per-build id by scripts/build-customer.mjs, so every deploy activates
// a new worker and evicts the previous shell in `activate`.
//
// The cross-origin pricing Worker is never cached, so prices are always live.
const CACHE = "metalquote-shell-20260724124446";
const SHELL = [
  "./", "./index.html", "./app.js", "./styles.css", "./manifest.webmanifest", "./icon.svg",
  "./lib/dxf.js", "./lib/svg.js", "./lib/nest.js", "./lib/pack.js",
  "./lib/qbiif.js", "./lib/quotedoc.js", "./lib/inventory.js", "./data/materials.json",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                // only cache GETs
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin (pricing Worker) → always network, never cached

  // Same-origin app shell: network-first, refreshing the cache; fall back to cache only when
  // the network fails (offline). A navigation that misses falls back to the cached shell.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});
