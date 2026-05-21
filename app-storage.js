/**
 * GastosApp — Storage & Sync Engine
 * - localStorage como fuente principal (respuesta instantánea)
 * - Sync con Google Sheets en background cada 10 minutos
 * - Cola de cambios pendientes para cuando no hay conexión
 * - Indicador visual de estado de sync
 */

const SHEETS_URL = "https://script.google.com/macros/s/AKfycbxBi_2LnML9JiUH_FlIQQ-mvwSYWbYajw7lxa2UKBapD-jLaabhdqeoOfbq-9E8GVY1/exec";
const LS_GASTOS    = "gastosapp_gastos";
const LS_QUEUE     = "gastosapp_queue";
const LS_LAST_SYNC = "gastosapp_last_sync";
const SYNC_INTERVAL = 10 * 60 * 1000; // 10 minutos

// ─── Indicador de sync ────────────────────────────────────────────────────────
function injectSyncIndicator() {
  if (document.getElementById("syncIndicator")) return;
  const el = document.createElement("div");
  el.id = "syncIndicator";
  el.innerHTML = `<i class="bi bi-circle-fill" id="syncDot"></i> <span id="syncLabel">Sincronizado</span>`;
  el.style.cssText = `
    position:fixed;bottom:16px;right:16px;z-index:9999;
    display:flex;align-items:center;gap:6px;
    background:#141826;border:1px solid #2a3050;border-radius:40px;
    padding:6px 12px;font-size:12px;font-family:'Sora',sans-serif;
    color:#94a3b8;box-shadow:0 4px 20px rgba(0,0,0,.4);
    transition:opacity 0.4s;opacity:0;pointer-events:none;
  `;
  document.body.appendChild(el);
}

function setSyncStatus(status) {
  // status: 'syncing' | 'ok' | 'pending' | 'error'
  const dot   = document.getElementById("syncDot");
  const label = document.getElementById("syncLabel");
  const ind   = document.getElementById("syncIndicator");
  if (!dot || !label || !ind) return;

  const map = {
    syncing: { color: "#6C63FF", text: "Sincronizando...", show: true  },
    ok:      { color: "#10b981", text: "Sincronizado",     show: true  },
    pending: { color: "#F59E0B", text: "Cambios pendientes", show: true },
    error:   { color: "#ef4444", text: "Sin conexión",     show: true  },
  };
  const cfg = map[status] || map.ok;
  dot.style.color   = cfg.color;
  dot.style.fontSize = status === "syncing" ? "8px" : "8px";
  label.textContent = cfg.text;
  ind.style.opacity = "1";

  if (status === "syncing") {
    dot.style.animation = "syncPulse 1s infinite";
  } else {
    dot.style.animation = "none";
    if (status === "ok") {
      setTimeout(() => { if (ind) ind.style.opacity = "0"; }, 3000);
    }
  }
}

// Inyectar keyframe de pulse
(function injectStyles() {
  if (document.getElementById("syncStyles")) return;
  const s = document.createElement("style");
  s.id = "syncStyles";
  s.textContent = `@keyframes syncPulse { 0%,100%{opacity:1} 50%{opacity:.3} }`;
  document.head.appendChild(s);
})();

// ─── localStorage helpers ─────────────────────────────────────────────────────
const Store = {
  getGastos() {
    try { return JSON.parse(localStorage.getItem(LS_GASTOS) || "[]"); }
    catch { return []; }
  },
  setGastos(gastos) {
    localStorage.setItem(LS_GASTOS, JSON.stringify(gastos));
  },
  getQueue() {
    try { return JSON.parse(localStorage.getItem(LS_QUEUE) || "[]"); }
    catch { return []; }
  },
  addToQueue(op) {
    const q = Store.getQueue();
    q.push({ ...op, ts: Date.now() });
    localStorage.setItem(LS_QUEUE, JSON.stringify(q));
    setSyncStatus("pending");
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
    return (Date.now() - Store.getLastSync()) > SYNC_INTERVAL;
  }
};

// ─── API helper (siempre GET querystring, sin preflight) ─────────────────────
async function sheetsCall(action, payload = {}) {
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

// ─── Sync: bajar todo de Sheets y mergear ────────────────────────────────────
async function syncFromSheets() {
  if (!navigator.onLine) { setSyncStatus("error"); return; }
  setSyncStatus("syncing");
  try {
    const data = await sheetsCall("getAll");
    const remote = data.gastos || [];

    // Mergear: local gana sobre remote para IDs que están en la queue
    const queue  = Store.getQueue();
    const queueIds = new Set(queue.map(op => op.id).filter(Boolean));
    const local  = Store.getGastos();
    const localMap = Object.fromEntries(local.map(g => [g.id, g]));

    // Tomar remote como base, sobreescribir con versiones locales pendientes
    const merged = remote.map(g => queueIds.has(g.id) && localMap[g.id] ? localMap[g.id] : g);
    // Agregar gastos locales que no existen en remote aún (recién creados pendientes)
    const remoteIds = new Set(remote.map(g => g.id));
    local.forEach(g => { if (!remoteIds.has(g.id)) merged.push(g); });

    Store.setGastos(merged);
    Store.setLastSync();
    setSyncStatus("ok");
    window.dispatchEvent(new CustomEvent("gastosUpdated"));
  } catch (e) {
    console.warn("Sync error:", e);
    setSyncStatus("error");
  }
}

// ─── Flush queue: enviar operaciones pendientes a Sheets ─────────────────────
async function flushQueue() {
  if (!navigator.onLine) return;
  const queue = Store.getQueue();
  if (queue.length === 0) return;

  setSyncStatus("syncing");
  const failed = [];
  for (const op of queue) {
    try {
      if (op.action === "create") {
        await sheetsCall("create", { gasto: op.gasto });
      } else if (op.action === "update") {
        await sheetsCall("update", { id: op.id, gasto: op.gasto });
      } else if (op.action === "delete") {
        await sheetsCall("delete", { id: op.id });
      }
    } catch (e) {
      failed.push(op);
    }
  }

  if (failed.length === 0) {
    Store.clearQueue();
    Store.setLastSync();
    setSyncStatus("ok");
  } else {
    localStorage.setItem(LS_QUEUE, JSON.stringify(failed));
    setSyncStatus("error");
  }
}

// ─── Operaciones CRUD (instantáneas en local + encolan para Sheets) ───────────
const GastosDB = {
  getAll() {
    return Store.getGastos().sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
  },

  create(gasto) {
    const gastos = Store.getGastos();
    gastos.push(gasto);
    Store.setGastos(gastos);
    Store.addToQueue({ action: "create", gasto });
    scheduleFlush();
    return gasto;
  },

  update(id, changes) {
    const gastos = Store.getGastos();
    const idx = gastos.findIndex(g => g.id === id);
    if (idx === -1) throw new Error("Gasto no encontrado");
    gastos[idx] = { ...gastos[idx], ...changes };
    Store.setGastos(gastos);
    Store.addToQueue({ action: "update", id, gasto: gastos[idx] });
    scheduleFlush();
    return gastos[idx];
  },

  delete(id) {
    const gastos = Store.getGastos().filter(g => g.id !== id);
    Store.setGastos(gastos);
    Store.addToQueue({ action: "delete", id });
    scheduleFlush();
  },

  // Carga inicial: usa local si es fresco, sino sincroniza
  async init() {
    injectSyncIndicator();
    const local = Store.getGastos();

    if (local.length > 0 && !Store.needsSync()) {
      // Datos frescos en local, usar directo
      const pending = Store.getQueue().length;
      if (pending > 0) {
        setSyncStatus("pending");
        scheduleFlush();
      }
      return local;
    }

    // Sin datos locales o pasaron 10 min → sincronizar
    await flushQueue();   // primero enviar pendientes
    await syncFromSheets(); // luego bajar actualizados
    return Store.getGastos();
  }
};

// ─── Flush diferido (evita spam de requests) ─────────────────────────────────
let flushTimer = null;
function scheduleFlush(delay = 2000) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushQueue, delay);
}

// ─── Sync automático cada 10 minutos ─────────────────────────────────────────
setInterval(async () => {
  await flushQueue();
  await syncFromSheets();
}, SYNC_INTERVAL);

// ─── Sync al volver online ────────────────────────────────────────────────────
window.addEventListener("online", async () => {
  await flushQueue();
  await syncFromSheets();
});
window.addEventListener("offline", () => setSyncStatus("error"));

// ─── Flush antes de cerrar la pestaña ────────────────────────────────────────
window.addEventListener("beforeunload", () => {
  const queue = Store.getQueue();
  if (queue.length > 0 && navigator.onLine) {
    // Sync síncrono de último recurso (best-effort)
    queue.forEach(op => {
      const url = new URL(SHEETS_URL);
      url.searchParams.set("action", op.action);
      if (op.gasto) url.searchParams.set("gasto", JSON.stringify(op.gasto));
      if (op.id)    url.searchParams.set("id", op.id);
      navigator.sendBeacon(url.toString());
    });
  }
});
