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

  // Keyframe pulse
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
    "position:fixed", "bottom:16px", "right:16px", "z-index:9999",
    "display:flex", "align-items:center", "gap:6px",
    "background:#141826", "border:1px solid #2a3050", "border-radius:40px",
    "padding:6px 14px", "font-size:12px", "font-family:'Sora',sans-serif",
    "color:#94a3b8", "box-shadow:0 4px 20px rgba(0,0,0,.4)",
    "transition:opacity 0.4s", "opacity:0", "pointer-events:none"
  ].join(";");
  document.body.appendChild(el);
}

function _setSyncStatus(status) {
  // Inyectar UI si todavía no existe (llamada temprana antes de DOMContentLoaded)
  if (!document.getElementById("syncIndicator")) _injectSyncUI();

  const dot   = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  const ind   = document.getElementById("syncIndicator");
  if (!dot || !label || !ind) return;

  const cfg = {
    syncing: { color: "#6C63FF", text: "Sincronizando...", pulse: true  },
    ok:      { color: "#10b981", text: "Sincronizado",     pulse: false },
    pending: { color: "#F59E0B", text: "Cambios pendientes",pulse: false },
    error:   { color: "#ef4444", text: "Sin conexión",     pulse: false },
  }[status] || { color: "#10b981", text: "Sincronizado", pulse: false };

  dot.style.color     = cfg.color;
  dot.style.animation = cfg.pulse ? "syncPulse 1s infinite" : "none";
  label.textContent   = cfg.text;
  ind.style.opacity   = "1";

  if (status === "ok") {
    setTimeout(() => { if (ind) ind.style.opacity = "0"; }, 3000);
  }
}

// ─── localStorage helpers ─────────────────────────────────────────────────────
const _Store = {
  getGastos() {
    try { return JSON.parse(localStorage.getItem(LS_GASTOS) || "[]"); }
    catch { return []; }
  },
  setGastos(arr) {
    localStorage.setItem(LS_GASTOS, JSON.stringify(arr));
  },
  getQueue() {
    try { return JSON.parse(localStorage.getItem(LS_QUEUE) || "[]"); }
    catch { return []; }
  },
  addToQueue(op) {
    const q = _Store.getQueue();
    q.push({ ...op, ts: Date.now() });
    localStorage.setItem(LS_QUEUE, JSON.stringify(q));
  },
  clearQueue() {
    localStorage.removeItem(LS_QUEUE);
  },
  getLastSync() {
    return parseInt(localStorage.getItem(LS_LAST_SYNC) || "0");
  },
  setLastSync() {
    localStorage.setItem(LS_LAST_SYNC, Date.now().toString());
  },
  needsSync() {
    return (Date.now() - _Store.getLastSync()) > SYNC_INTERVAL;
  }
};

// ─── API helper — siempre GET querystring para evitar preflight CORS ──────────
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

// ─── Flush: enviar operaciones pendientes a Sheets ────────────────────────────
async function _flushQueue() {
  if (!navigator.onLine) return;
  const queue = _Store.getQueue();
  if (queue.length === 0) return;

  _setSyncStatus("syncing");
  const failed = [];

  for (const op of queue) {
    try {
      if      (op.action === "create") await _sheetsCall("create", { gasto: op.gasto });
      else if (op.action === "update") await _sheetsCall("update", { id: op.id, gasto: op.gasto });
      else if (op.action === "delete") await _sheetsCall("delete", { id: op.id });
    } catch {
      failed.push(op);
    }
  }

  if (failed.length === 0) {
    _Store.clearQueue();
    _Store.setLastSync();
    _setSyncStatus("ok");
  } else {
    localStorage.setItem(LS_QUEUE, JSON.stringify(failed));
    _setSyncStatus("error");
  }
}

// ─── Sync: bajar todo de Sheets y actualizar caché ───────────────────────────
async function _syncFromSheets() {
  if (!navigator.onLine) { _setSyncStatus("error"); return; }
  _setSyncStatus("syncing");
  try {
    const data   = await _sheetsCall("getAll");
    const remote = data.gastos || [];

    // Mantener versiones locales de IDs que están en la queue (sin sobreescribir)
    const queue     = _Store.getQueue();
    const queueIds  = new Set(queue.map(op => op.id).filter(Boolean));
    const local     = _Store.getGastos();
    const localMap  = Object.fromEntries(local.map(g => [g.id, g]));
    const remoteIds = new Set(remote.map(g => g.id));

    const merged = remote.map(g =>
      queueIds.has(g.id) && localMap[g.id] ? localMap[g.id] : g
    );
    // Agregar gastos locales aún no subidos (recién creados pendientes)
    local.forEach(g => { if (!remoteIds.has(g.id)) merged.push(g); });

    _Store.setGastos(merged);
    _Store.setLastSync();
    _setSyncStatus("ok");
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
  } catch (err) {
    console.warn("GastosApp sync error:", err);
    _setSyncStatus("error");
  }
}

// ─── Flush diferido (evita spam de requests) ─────────────────────────────────
let _flushTimer = null;
function _scheduleFlush(delay = 2000) {
  clearTimeout(_flushTimer);
  _flushTimer = setTimeout(_flushQueue, delay);
}

// ─── Sync automático cada 10 minutos ─────────────────────────────────────────
setInterval(async () => {
  await _flushQueue();
  await _syncFromSheets();
}, SYNC_INTERVAL);

// ─── Sync al recuperar conexión ───────────────────────────────────────────────
window.addEventListener("online",  async () => { await _flushQueue(); await _syncFromSheets(); });
window.addEventListener("offline", ()        => _setSyncStatus("error"));

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

  /**
   * Devuelve todos los gastos ordenados por fecha desc (síncrono, desde caché).
   */
  getAll() {
    return _Store.getGastos().sort((a, b) =>
      (b.fecha || "").localeCompare(a.fecha || "")
    );
  },

  /**
   * Crea un gasto nuevo.
   * Escribe en localStorage al instante y encola el sync con Sheets.
   */
  create(gasto) {
    const gastos = _Store.getGastos();
    gastos.push(gasto);
    _Store.setGastos(gastos);
    _Store.addToQueue({ action: "create", gasto });
    _setSyncStatus("pending");
    _scheduleFlush();
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
    return gasto;
  },

  /**
   * Actualiza un gasto existente por id.
   */
  update(id, changes) {
    const gastos = _Store.getGastos();
    const idx    = gastos.findIndex(g => g.id === id);
    if (idx === -1) throw new Error("Gasto no encontrado: " + id);
    gastos[idx] = { ...gastos[idx], ...changes };
    _Store.setGastos(gastos);
    _Store.addToQueue({ action: "update", id, gasto: gastos[idx] });
    _setSyncStatus("pending");
    _scheduleFlush();
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
    return gastos[idx];
  },

  /**
   * Elimina un gasto por id.
   */
  delete(id) {
    _Store.setGastos(_Store.getGastos().filter(g => g.id !== id));
    _Store.addToQueue({ action: "delete", id });
    _setSyncStatus("pending");
    _scheduleFlush();
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
  },

  /**
   * Inicialización asíncrona.
   * - Si hay datos frescos en localStorage: los devuelve de inmediato
   *   y lanza sync en background.
   * - Si localStorage está vacío o los datos tienen >10 min:
   *   espera la sync y devuelve los datos actualizados.
   */
  async init() {
    // Inyectar UI de sync en cuanto el DOM esté listo
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", _injectSyncUI);
    } else {
      _injectSyncUI();
    }

    const local   = _Store.getGastos();
    const pending = _Store.getQueue().length;

    if (local.length > 0 && !_Store.needsSync()) {
      // Datos frescos: mostrar al instante, sync en background
      if (pending > 0) {
        _setSyncStatus("pending");
        _scheduleFlush();
      }
      // Background sync sin bloquear
      _flushQueue().then(_syncFromSheets).catch(() => {});
      return GastosDB.getAll();
    }

    // Sin datos locales o caducados: esperar sync completa
    await _flushQueue();
    await _syncFromSheets();
    return GastosDB.getAll();
  },

  /** Fuerza una sincronización inmediata con Sheets. */
  sync() {
    return _flushQueue().then(_syncFromSheets);
  }
};
