/**
 * GastosApp — Service Worker
 * Cachea solo los archivos que existen. Funciona offline con lo que tenga.
 */
const CACHE_NAME = "gastosapp-v2";

// Solo cachear archivos que sabemos que existen
const CORE_FILES = [
  "./",
  "./index.html",
  "./dashboard.html",
  "./gastos.html",
  "./historial.html",
  "./nuevo.html",
  "./app-storage.js",
  "https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap",
  "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      // Cache cada archivo individualmente para que un 404 no rompa todo
      for (const url of CORE_FILES) {
        try {
          await cache.add(url);
        } catch (e) {
          console.warn("SW: no se pudo cachear", url, e.message);
        }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  // No interceptar llamadas a Google Sheets (siempre necesitan red)
  if (event.request.url.includes("script.google.com")) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Solo cachear respuestas válidas de nuestro origen
        if (response.ok && (event.request.url.startsWith(self.location.origin) || event.request.url.startsWith("https://cdn.jsdelivr.net"))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached || new Response("Offline", { status: 503 }));
    })
  );
});
