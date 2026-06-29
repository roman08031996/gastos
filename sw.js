/**
 * GastosApp — Service Worker v4
 * Estrategia: Network-first para HTML/JS, Cache-first para fuentes y CDN
 */
const CACHE_NAME = "gastosapp-v4";

const CACHE_CDN = [
  "https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap",
  "https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"
];

// Archivos propios — se pre-cachean pero siempre se intenta la red primero
const APP_FILES = [
  "./index.html",
  "./dashboard.html",
  "./gastos.html",
  "./historial.html",
  "./nuevo.html",
  "./admin.html",
  "./app-storage.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      for (const url of [...APP_FILES, ...CACHE_CDN]) {
        try { await cache.add(url); }
        catch (e) { console.warn("SW: no se pudo cachear", url, e.message); }
      }
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    // Eliminar TODOS los caches viejos
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => {
        console.log("SW: eliminando cache viejo:", k);
        return caches.delete(k);
      }))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const url = event.request.url;

  // Nunca interceptar Google Sheets
  if (url.includes("script.google.com")) return;

  // CDN (fuentes, iconos, chart.js) → Cache-first (raramente cambian)
  const isCDN = url.includes("fonts.googleapis.com") ||
                url.includes("fonts.gstatic.com") ||
                url.includes("cdn.jsdelivr.net");
  if (isCDN) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Archivos propios (HTML, JS) → Network-first: siempre intenta red,
  // usa cache solo si la red falla (offline)
  event.respondWith(
    fetch(event.request)
      .then(res => {
        // Si la respuesta es válida, actualizar el cache
        if (res.ok && res.type !== "opaque") {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() => {
        // Sin red → servir desde cache
        return caches.match(event.request)
          .then(cached => cached || new Response("Sin conexión", { status: 503 }));
      })
  );
});
