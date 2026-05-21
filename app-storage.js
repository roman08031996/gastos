/**
 * GastosApp — app-storage.js
 * localStorage como fuente principal (respuesta instantánea)
 * Sync con Google Sheets en background cada 10 minutos
 * Cola de cambios pendientes para cuando no hay conexión
 * Indicador visual de estado de sync
 */

const SHEETS_URL    = "https://script.google.com/macros/s/AKfycbxBi_2LnML9JiUH_FlIQQ-mvwSYWbYajw7lxa2UKBapD-jLaabhdqeoOfbq-9E8GVY1/exec";
const LS_GASTOS     = "gastosapp_gastos";
const LS_QUEUE      = "gastosapp_queue";
const LS_LAST_SYNC  = "gastosapp_last_sync";
const SYNC_INTERVAL = 10 * 60 * 1000; // 10 minutos

// ─── Indicador de sync ────────────────────────────────────────────────────────
function _injectSyncUI() {
  if (document.getElementById("syncIndicator")) return;
  if (!document.getElementById("syncStyles")) {
    const s = document.createElement("style");
    s.id = "syncStyles";
    s.textContent = `@keyframes syncPulse { 0%,100%{opacity:1} 50%{opacity:.3} }`;
    document.head.appendChild(s);
  }
  const el = document.createElement("div");
  el.id = "syncIndicator";
  el.innerHTML = `<i class="bi bi-circle-fill" id="syncDot" style="font-size:8px"></i><span id="syncLabel">Sincronizado</span>`;
  el.style.cssText = [
    "position:fixed","bottom:16px","right:16px","z-index:9999",
    "display:flex","align-items:center","gap:6px",
    "background:#141826","border:1px solid #2a3050","border-radius:40px",
    "padding:6px 14px","font-size:12px","font-family:'Sora',sans-serif",
    "color:#94a3b8","box-shadow:0 4px 20px rgba(0,0,0,.4)",
    "transition:opacity 0.4s","opacity:0","pointer-events:none"
  ].join(";");
  document.body.appendChild(el);
}

function _setSyncStatus(status) {
  if (!document.getElementById("syncIndicator")) _injectSyncUI();
  const dot = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  const ind = document.getElementById("syncIndicator");
  if (!dot || !label || !ind) return;
  const cfg = {
    syncing: { color: "#6C63FF", text: "Sincronizando...", pulse: true  },
    ok:      { color: "#10b981", text: "Sincronizado",     pulse: false },
    pending: { color: "#F59E0B", text: "Cambios pendientes", pulse: false },
    error:   { color: "#ef4444", text: "Sin conexión",     pulse: false },
  }[status] || { color: "#10b981", text: "Sincronizado", pulse: false };
  dot.style.color = cfg.color;
  dot.style.animation = cfg.pulse ? "syncPulse 1s infinite" : "none";
  label.textContent = cfg.text;
  ind.style.opacity = "1";
  if (status === "ok") setTimeout(() => { if (ind) ind.style.opacity = "0"; }, 3000);
}

// ─── localStorage helpers ─────────────────────────────────────────────────────
const _Store = {
  getGastos() {
    try { return JSON.parse(localStorage.getItem(LS_GASTOS) || "[]"); } catch { return []; }
  },
  setGastos(arr) { localStorage.setItem(LS_GASTOS, JSON.stringify(arr)); },
  getQueue() {
    try { return JSON.parse(localStorage.getItem(LS_QUEUE) || "[]"); } catch { return []; }
  },
  setQueue(q) { localStorage.setItem(LS_QUEUE, JSON.stringify(q)); },
  clearQueue() { localStorage.removeItem(LS_QUEUE); },
  getLastSync() { return parseInt(localStorage.getItem(LS_LAST_SYNC) || "0"); },
  setLastSync() { localStorage.setItem(LS_LAST_SYNC, Date.now().toString()); },
  needsSync() { return (Date.now() - _Store.getLastSync()) > SYNC_INTERVAL; }
};

// ─── API helper — GET querystring para evitar preflight CORS ─────────────────
async function _sheetsCall(action, payload = {}) {
  const url = new URL(SHEETS_URL);
  url.searchParams.set("action", action);
  Object.entries(payload).forEach(([k, v]) =>
    url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : v)
  );
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ─── Mutex: evita que _flushQueue y _syncFromSheets corran en paralelo ────────
let _syncing = false;

// ─── Flush: enviar operaciones pendientes a Sheets ────────────────────────────
// Retorna true si completó, false si había otra ejecución en curso
async function _flushQueue() {
  if (!navigator.onLine) return;
  if (_syncing) return;           // ← MUTEX: ya hay una sync en curso, salir
  const queue = _Store.getQueue();
  if (queue.length === 0) return;

  _syncing = true;
  _setSyncStatus("syncing");

  // Snapshot de la queue actual — procesar solo estas operaciones
  // Así si llega un create nuevo mientras flusheamos, no lo tocamos
  const toProcess = [...queue];
  const failed = [];

  for (const op of toProcess) {
    try {
      if      (op.action === "create") await _sheetsCall("create", { gasto: op.gasto });
      else if (op.action === "update") await _sheetsCall("update", { id: op.id, gasto: op.gasto });
      else if (op.action === "delete") await _sheetsCall("delete", { id: op.id });
    } catch {
      failed.push(op);
    }
  }

  // De la queue actual, remover solo las que procesamos (pueden haber llegado nuevas)
  const currentQueue = _Store.getQueue();
  const processedTs  = new Set(toProcess.map(op => op.ts));
  const remaining    = currentQueue.filter(op => !processedTs.has(op.ts) || failed.some(f => f.ts === op.ts));
  _Store.setQueue(remaining);

  if (failed.length === 0) {
    _Store.setLastSync();
    _setSyncStatus(remaining.length > 0 ? "pending" : "ok");
  } else {
    _setSyncStatus("error");
  }

  _syncing = false;
}

// ─── Sync: bajar todo de Sheets y actualizar caché ───────────────────────────
async function _syncFromSheets() {
  if (!navigator.onLine) { _setSyncStatus("error"); return; }
  if (_syncing) return;           // ← MUTEX
  _syncing = true;
  _setSyncStatus("syncing");

  try {
    const data   = await _sheetsCall("getAll");
    const remote = data.gastos || [];

    // Merge sin duplicados usando Map keyed por ID
    // Remote es la fuente de verdad, EXCEPTO para IDs con ops pendientes
    // donde la versión local gana para no perder cambios offline
    const queue    = _Store.getQueue();
    const queueIds = new Set(queue.map(op => op.id).filter(Boolean));
    // Para creates pendientes: el gasto está en la queue, no en queueIds (que es por op.id)
    const pendingCreateIds = new Set(
      queue.filter(op => op.action === "create").map(op => op.gasto?.id).filter(Boolean)
    );
    const local    = _Store.getGastos();
    const localMap = Object.fromEntries(local.map(g => [g.id, g]));

    // Base: remote
    const mergeMap = new Map(remote.map(g => [g.id, g]));

    // Sobreescribir con local para updates/deletes pendientes
    queueIds.forEach(id => {
      if (localMap[id]) mergeMap.set(id, localMap[id]);
    });

    // Para creates pendientes: si ya llegaron a remote, usamos remote (evitar duplicado)
    // Si NO llegaron aún, los agregamos desde local
    pendingCreateIds.forEach(id => {
      if (!mergeMap.has(id) && localMap[id]) {
        mergeMap.set(id, localMap[id]);
      }
      // Si ya está en remote, no hacer nada — remote ya tiene la copia correcta
    });

    _Store.setGastos(Array.from(mergeMap.values()));
    _Store.setLastSync();
    _setSyncStatus("ok");
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
  } catch (err) {
    console.warn("GastosApp sync error:", err);
    _setSyncStatus("error");
  }

  _syncing = false;
}

// ─── Flush diferido (evita spam de requests) ─────────────────────────────────
let _flushTimer = null;
function _scheduleFlush(delay = 2000) {
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(async () => {
    await _flushQueue();
    // Después del flush, sync para que local refleje el estado real de Sheets
    if (_Store.getQueue().length === 0) await _syncFromSheets();
  }, delay);
}

// ─── Sync automático cada 10 minutos ─────────────────────────────────────────
setInterval(async () => {
  await _flushQueue();
  await _syncFromSheets();
}, SYNC_INTERVAL);

// ─── Sync al recuperar conexión ───────────────────────────────────────────────
window.addEventListener("online",  async () => { await _flushQueue(); await _syncFromSheets(); });
window.addEventListener("offline", () => _setSyncStatus("error"));

// ─── Flush de último recurso al cerrar la pestaña ────────────────────────────
window.addEventListener("beforeunload", () => {
  const queue = _Store.getQueue();
  if (queue.length > 0 && navigator.onLine) {
    queue.forEach(op => {
      const url = new URL(SHEETS_URL);
      url.searchParams.set("action", op.action);
      if (op.gasto) url.searchParams.set("gasto", JSON.stringify(op.gasto));
      if (op.id)    url.searchParams.set("id", op.id);
      navigator.sendBeacon(url.toString());
    });
  }
});

// ─── GastosDB — API pública ───────────────────────────────────────────────────
const GastosDB = {

  /** Devuelve todos los gastos ordenados por fecha desc (síncrono, desde caché). */
  getAll() {
    return _Store.getGastos().sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  },

  /** Crea un gasto nuevo. Escribe en localStorage al instante y encola sync con Sheets. */
  create(gasto) {
    const gastos = _Store.getGastos();
    // Guardia: nunca insertar el mismo ID dos veces en local
    if (gastos.some(g => g.id === gasto.id)) {
      console.warn("GastosDB.create: ID duplicado ignorado", gasto.id);
      return gasto;
    }
    gastos.push(gasto);
    _Store.setGastos(gastos);
    // Guardia: no encolar el mismo create dos veces
    const queue = _Store.getQueue();
    if (!queue.some(op => op.action === "create" && op.gasto?.id === gasto.id)) {
      queue.push({ action: "create", gasto, ts: Date.now() });
      _Store.setQueue(queue);
    }
    _setSyncStatus("pending");
    _scheduleFlush();
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
    return gasto;
  },

  /** Actualiza un gasto existente por id. */
  update(id, changes) {
    const gastos = _Store.getGastos();
    const idx = gastos.findIndex(g => g.id === id);
    if (idx === -1) throw new Error("Gasto no encontrado: " + id);
    gastos[idx] = { ...gastos[idx], ...changes };
    _Store.setGastos(gastos);
    const queue = _Store.getQueue();
    queue.push({ action: "update", id, gasto: gastos[idx], ts: Date.now() });
    _Store.setQueue(queue);
    _setSyncStatus("pending");
    _scheduleFlush();
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
    return gastos[idx];
  },

  /** Elimina un gasto por id. */
  delete(id) {
    _Store.setGastos(_Store.getGastos().filter(g => g.id !== id));
    const queue = _Store.getQueue();
    queue.push({ action: "delete", id, ts: Date.now() });
    _Store.setQueue(queue);
    _setSyncStatus("pending");
    _scheduleFlush();
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
  },

  /**
   * Inicialización asíncrona.
   * Si hay datos frescos en localStorage: devuelve inmediato, sync en background.
   * Si no: espera la sync completa.
   */
  async init() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _injectSyncUI);
    } else {
      _injectSyncUI();
    }

    const local   = _Store.getGastos();
    const pending = _Store.getQueue().length;

    if (local.length > 0 && !_Store.needsSync()) {
      if (pending > 0) {
        _setSyncStatus("pending");
        // Flush en background SIN sync posterior inmediata
        // (la sync vendrá sola al completarse el flush via _scheduleFlush)
        setTimeout(_flushQueue, 500);
      }
      return GastosDB.getAll();
    }

    // Sin datos locales o caducados: flush primero, luego sync
    await _flushQueue();
    await _syncFromSheets();
    return GastosDB.getAll();
  },

  /** Fuerza una sincronización inmediata con Sheets. */
  async sync() {
    await _flushQueue();
    await _syncFromSheets();
  }
};
