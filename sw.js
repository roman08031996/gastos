const CACHE_NAME = "gastosapp-v1";
const STATIC_ASSETS = [
  "/GastosApp/index.html",
  "/GastosApp/dashboard.html",
  "/GastosApp/nuevo.html",
  "/GastosApp/gastos.html",
  "/GastosApp/historial.html",
  "/GastosApp/app-storage.js",
  "/GastosApp/manifest.json"
];

// Instalar: cachear archivos estáticos
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activar: limpiar caches viejos
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: cache-first para assets propios, network-first para Sheets API
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Google Sheets API → siempre network, nunca cachear
  if (url.hostname.includes("script.google.com")) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ error: "Sin conexión" }), {
          headers: { "Content-Type": "application/json" }
        })
      )
    );
    return;
  }

  // Fuentes / CDN → cache-first
  if (url.hostname.includes("fonts.googleapis.com") ||
      url.hostname.includes("fonts.gstatic.com") ||
      url.hostname.includes("cdn.jsdelivr.net")) {
    event.respondWith(
      caches.match(event.request).then(cached =>
        cached || fetch(event.request).then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
      )
    );
    return;
  }

  // Archivos propios → cache-first con fallback a network
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
});
