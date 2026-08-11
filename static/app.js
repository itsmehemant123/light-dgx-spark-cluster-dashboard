"use strict";

const NODES = ["head", "worker"];

// Client-side time series. Browser-only, never sent to the server.
// Fine buffer is capped and decimated-by-2 (keeps every 2nd point) once full,
// so memory stays flat for the life of the tab.
const series = { head: {}, worker: {} };
const FINE_CAP = 3600;

const METRICS = [
  { key: "soc_temp",   label: "SoC pkg temp", unit: "°C",  agg: "avg", color: "#eab308" },
  { key: "gpu_temp",   label: "GPU temp",     unit: "°C",  agg: "avg", color: "#ef4444" },
  { key: "vram_temp",  label: "VRAM temp",    unit: "°C",  agg: "avg", color: "#a78bfa" },
  { key: "power_total", label: "Power total", unit: "W",   agg: "sum", color: "#f97316" },
  { key: "power_gpu",  label: "Power GPU",    unit: "W",   agg: "sum", color: "#f87171" },
  { key: "clk_gpu",    label: "GPU clock",    unit: "MHz", agg: "avg", color: "#22d3ee" },
  { key: "clk_mem",    label: "Mem clock",    unit: "MHz", agg: "avg", color: "#818cf8" },
  { key: "clk_cpu",    label: "CPU clock",    unit: "MHz", agg: "avg", color: "#34d399" },
  { key: "cpu_pct",    label: "CPU",          unit: "%",   agg: "avg", color: "#38bdf8" },
  { key: "ram_pct",    label: "RAM",          unit: "%",   agg: "avg", color: "#f472b6" },
  { key: "gpu_util",   label: "GPU util",     unit: "%",   agg: "avg", color: "#a3e635" },
  { key: "tokens_rate", label: "Tokens",       unit: "/s",  agg: "avg", color: "#c084fc", always: true },
  { key: "active_req",  label: "Active reqs",  unit: "",    agg: "avg", color: "#22d3ee", always: true },
];
const ALL_KEYS = METRICS.map(m => m.key);
const EXTRA = [
  { key: "fan",  label: "Fans",     unit: "rpm" },
  { key: "nvme", label: "NVMe temp", unit: "°C" },
];

const PLOT_DEFS = [
  { canvas: "plot-temp",  keys: ["soc_temp", "gpu_temp", "vram_temp"], mode: "avg" },
  { canvas: "plot-power", keys: ["power_total", "power_gpu"],          mode: "sum" },
  { canvas: "plot-clock", keys: ["clk_gpu", "clk_mem", "clk_cpu"],     mode: "avg" },
  { canvas: "plot-util",  keys: ["cpu_pct", "ram_pct", "gpu_util"],    mode: "avg" },
  { canvas: "plot-tokens", keys: ["tokens_rate"],                      mode: "avg" },
];

let view = "per";
let lastMap = {};
let lastNums = {};
let vllm = null;
let tileRefs = null;
const legendCache = {};
const statCache = {};

// Plot window (seconds; 0 = all/live) and hidden traces + per-metric thresholds.
let timeWindow = 0;
const hiddenTraces = new Set();
const thresholds = {};      // metric key -> alert-above value (undefined = off)
const alerting = {};        // metric key -> currently over threshold (for notifications)
let alertsOpen = false;

// Show-vs-hide for metrics that report no value on the current hardware
// (e.g. GB10 GPU memory, memory temp, mem clock). Client-side only.
let showUnavail = false;
const everHad = {}; // metric key -> true once any node reported a real value
let lastAvailSig = "";

function el(tag, cls, text) { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; }
function fmt(v) { return (typeof v === "number") ? (Math.round(v * 10) / 10).toString() : String(v); }
function clock(t) { return new Date(t * 1000).toTimeString().slice(0, 8); }

// ---- node value extraction ----
function nodeNumbers(m) {
  if (!m) return null;
  const g = (m.gpu && m.gpu.length) ? m.gpu[0] : null;
  const gpuPow = m.gpu ? m.gpu.reduce((a, x) => a + (x.power_w || 0), 0) : null;
  let ptotal = null;
  if (m.power) for (const k in m.power) if (/sys_total|dc_input|sm_anthem/.test(k)) { ptotal = m.power[k]; break; }
  return {
    soc_temp: m.soc_temp_c, gpu_temp: g ? g.temp_c : null, vram_temp: g ? (g.mem_temp_c || null) : null,
    power_total: ptotal, power_gpu: gpuPow,
    clk_gpu: g ? (g.clock_graphics_mhz || g.clock_sm_mhz) : null, clk_mem: g ? g.clock_mem_mhz : null, clk_cpu: m.cpu_clk_mhz,
    cpu_pct: m.cpu_pct, ram_pct: (m.ram ? m.ram.pct : null), gpu_util: g ? g.util_pct : null,
    tokens_rate: m.vllm && m.vllm.reachable && m.vllm.gen_tokens_rate >= 0 ? m.vllm.gen_tokens_rate : null,
    active_req: m.vllm && m.vllm.reachable && m.vllm.running_requests >= 0 ? m.vllm.running_requests : null,
    fan: (m.fans && Object.keys(m.fans).length) ? Object.values(m.fans).map(v => Math.round(v)).join(" / ") : null,
    nvme: m.nvme_temp_c != null ? Math.round(m.nvme_temp_c) : null,
    up: m.up, source: m.source || "",
  };
}

// ---- series buffer ----
function push(node, key, t, v) {
  if (v == null || v === "") return;
  everHad[key] = true;
  let a = series[node][key] || (series[node][key] = []);
  a.push({ t, v });
  if (a.length > FINE_CAP) {
    const out = [];
    for (let i = 0; i < a.length; i += 2) out.push(a[i]);
    if (out[out.length - 1].t !== a[a.length - 1].t) out.push(a[a.length - 1]);
    series[node][key] = out;
  }
}

// A metric counts as "available" if it's marked always-visible (e.g. the vLLM
// token cards), if in show mode everything is shown, or if any node has ever
// reported a real (non-null) value for it.
function isAvailable(key) {
  const def = METRICS.find(m => m.key === key);
  return showUnavail || (def && def.always) || everHad[key] === true;
}

function availSig() {
  return METRICS.concat(EXTRA).map(m => (isAvailable(m.key) ? 1 : 0)).join("");
}
function availChanged() {
  const s = availSig();
  if (s !== lastAvailSig) { lastAvailSig = s; return true; }
  return false;
}

function aggSeries(key, reducer) {
  const a = series.head[key] || [], b = series.worker[key] || [];
  if (!a.length) return b;
  if (!b.length) return a;
  const n = Math.min(a.length, b.length), out = [];
  for (let i = 0; i < n; i++) { if (a[i].v == null || b[i].v == null) continue; out.push({ t: (a[i].t + b[i].t) / 2, v: reducer(a[i].v, b[i].v) }); }
  return out;
}

// ---- tiles ----
function buildTiles(v) {
  const c = document.getElementById("tiles");
  c.innerHTML = "";
  tileRefs = {};
  const metrics = METRICS.concat(EXTRA).filter(m => isAvailable(m.key));
  const LARGE_KEYS = ["cpu_pct", "gpu_util", "ram_pct"];
  for (const m of metrics) {
    const card = el("div", "card" + (LARGE_KEYS.includes(m.key) ? " card-lg" : ""));
    card.appendChild(el("div", "lbl", m.label + (m.unit ? " · " + m.unit : "")));
    const ref = {};
    if (v === "per") {
      const vals = el("div", "vals"); card.appendChild(vals);
      for (const node of NODES) {
        const cell = el("div", "val"); cell.dataset.node = node;
        cell.appendChild(el("div", "num", "—"));
        cell.appendChild(el("div", "node", node));
        vals.appendChild(cell); ref[node] = cell;
      }
    } else {
      const cell = el("div", "val"); cell.dataset.node = "agg";
      cell.appendChild(el("div", "num", "—"));
      card.appendChild(cell); ref.agg = cell;
    }
    tileRefs[m.key] = ref;
    c.appendChild(card);
  }
}

const TILE_METRIC_KEYS = METRICS.map(m => m.key);
const TILE_EXTRA_KEYS = EXTRA.map(m => m.key);

function setNum(cell, val, up) {
  const num = cell.querySelector(".num");
  if (val == null) { num.textContent = "N/A"; cell.classList.add("na"); }
  else { num.textContent = fmt(val); cell.classList.remove("na"); }
  cell.classList.toggle("down", up === false);
}

function updateTiles() {
  if (!tileRefs) return;
  const hn = lastNums.head, wn = lastNums.worker;
  for (const key of TILE_METRIC_KEYS) {
    const ref = tileRefs[key]; if (!ref) continue;
    const def = METRICS.find(m => m.key === key);
    if (view === "agg") {
      const hv = hn ? hn[key] : null, wv = wn ? wn[key] : null;
      let v = null;
      if (hv != null && wv != null) v = def.agg === "sum" ? hv + wv : (hv + wv) / 2;
      else if (hv != null) v = hv; else if (wv != null) v = wv;
      setNum(ref.agg, v, (hn ? hn.up : false) || (wn ? wn.up : false));
    } else {
      for (const node of NODES) { const n = node === "head" ? hn : wn; setNum(ref[node], n ? n[key] : null, n ? n.up : false); }
    }
  }
  for (const key of TILE_EXTRA_KEYS) {
    const ref = tileRefs[key]; if (!ref) continue;
    if (view === "agg") {
      const parts = [];
      if (hn && hn[key] != null) parts.push(hn[key]);
      if (wn && wn[key] != null) parts.push(wn[key]);
      setNum(ref.agg, parts.length ? parts.join(" · ") : null, true);
    } else {
      for (const node of NODES) { const n = node === "head" ? hn : wn; setNum(ref[node], n ? n[key] : null, n ? n.up : false); }
    }
  }
}

// ---- status / badge ----
function setStatus(headUp, workerUp) {
  const s = document.getElementById("status");
  s.classList.remove("up", "down", "partial");
  const t = document.getElementById("status-text");
  if (!headUp) { s.classList.add("down"); t.textContent = "head offline"; return; }
  if (workerUp === undefined || workerUp === true) { s.classList.add("up"); t.textContent = "head + worker online"; }
  else { s.classList.add("partial"); t.textContent = "head online · worker OFFLINE"; }
}

function updateBadge() {
  const live = document.getElementById("live");
  const tok = document.getElementById("tokens");
  let generating = false;
  if (vllm && vllm.reachable) {
    tok.hidden = false;
    const rate = vllm.gen_tokens_rate >= 0 ? Math.round(vllm.gen_tokens_rate) : "—";
    tok.textContent = "tokens/s " + rate + " · active " + Math.round(vllm.running_requests || 0);
    if (vllm.running_requests > 0 || vllm.gen_tokens_rate > 0) generating = true;
  } else { tok.hidden = true; }
  for (const n of NODES) { const g = lastNums[n]; if (g && g.up && g.gpu_util > 20 && g.power_gpu > 40) generating = true; }
  live.hidden = !generating;
}

// ---- plots ----
// Lighten/desaturate a #rrggbb color so head & worker traces of the same
// metric stay identifiable by shade while sharing the metric's hue.
function shadeColor(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const gray = 0.2989 * r + 0.5870 * g + 0.1140 * b;
  r = Math.round(r + (gray - r) * amt + (255 - r) * amt * 0.4);
  g = Math.round(g + (gray - g) * amt + (255 - g) * amt * 0.4);
  b = Math.round(b + (gray - b) * amt + (255 - b) * amt * 0.4);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

function collectTraces(def) {
  const traces = [];
  if (view === "agg") {
    for (const key of def.keys) {
      const pts = aggSeries(key, def.mode === "sum" ? (a, b) => a + b : (a, b) => (a + b) / 2);
      if (pts.length) traces.push({ label: key, color: METRICS.find(m => m.key === key).color, pts });
    }
  } else {
    for (const key of def.keys) {
      const base = METRICS.find(m => m.key === key).color;
      for (const node of NODES) { const pts = series[node][key] || []; if (pts.length) traces.push({ label: key + "·" + node, color: node === "head" ? base : shadeColor(base, 0.5), pts }); }
    }
  }
  return traces;
}

function legendEl(canvasId) {
  if (legendCache[canvasId]) return legendCache[canvasId];
  const plot = document.getElementById(canvasId).closest(".plot");
  const l = plot.querySelector(".legend");
  legendCache[canvasId] = l; return l;
}

function statEl(canvasId) {
  if (statCache[canvasId]) return statCache[canvasId];
  const plot = document.getElementById(canvasId).closest(".plot");
  const s = plot.querySelector(".plot-title .stat");
  statCache[canvasId] = s; return s;
}

function toggleTrace(label) {
  if (hiddenTraces.has(label)) hiddenTraces.delete(label); else hiddenTraces.add(label);
  drawAll();
}

function draw(def) {
  const cv = document.getElementById(def.canvas);
  if (!cv) return;
  const W = cv.clientWidth || 300, H = cv.clientHeight || 180;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.floor(W * dpr)) cv.width = Math.floor(W * dpr);
  if (cv.height !== Math.floor(H * dpr)) cv.height = Math.floor(H * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement);
  const gridCol = cs.getPropertyValue("--grid").trim() || "#1c2733";
  const dimCol = cs.getPropertyValue("--dim").trim() || "#7d8b99";

  const all = collectTraces(def);

  // Legend (includes hidden traces so they can be re-shown; clickable).
  const leg = legendEl(def.canvas); leg.innerHTML = "";
  for (const tr of all) {
    const s = el("span", hiddenTraces.has(tr.label) ? "hidden" : "");
    s.style.color = tr.color; s.textContent = tr.label;
    s.addEventListener("click", () => toggleTrace(tr.label));
    leg.appendChild(s);
  }

  // Determine window lower bound from the newest sample across traces.
  let now = -Infinity;
  for (const tr of all) for (const p of tr.pts) if (p.t > now) now = p.t;
  const lo = timeWindow > 0 ? now - timeWindow : null;

  // Window-filter traces (skip hidden), gather stats over the shown window.
  const traces = [];
  let minT = Infinity, maxT = -Infinity, minV = Infinity, maxV = -Infinity, sum = 0, count = 0;
  for (const tr of all) {
    if (hiddenTraces.has(tr.label)) continue;
    const pts = lo ? tr.pts.filter(p => p.t >= lo) : tr.pts;
    if (!pts.length) continue;
    traces.push({ ...tr, pts });
    for (const p of pts) { if (p.t < minT) minT = p.t; if (p.t > maxT) maxT = p.t; if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v; sum += p.v; count++; }
  }
  const stMin = minV, stAvg = count ? sum / count : NaN, stMax = maxV;

  const stat = statEl(def.canvas);
  if (count) stat.textContent = `min ${fmt(stMin)} · avg ${fmt(stAvg)} · max ${fmt(stMax)}`;
  else stat.textContent = "";

  if (!isFinite(minT) || traces.length === 0) {
    ctx.fillStyle = dimCol; ctx.textAlign = "center"; ctx.fillText("waiting for data…", W / 2, H / 2);
    return;
  }
  const pad = (maxV - minV) * 0.08 || 1; minV = Math.max(0, minV - pad); maxV = maxV + pad;
  if (maxV === minV) maxV = minV + 1;
  const range = (maxT - minT) || 1;

  ctx.strokeStyle = gridCol; ctx.fillStyle = dimCol; ctx.font = "10px sans-serif"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yy = H - ((H - 24) * i / 4);
    ctx.beginPath(); ctx.moveTo(42, yy); ctx.lineTo(W - 6, yy); ctx.stroke();
    ctx.textAlign = "left"; ctx.fillText(String(Math.round(minV + (maxV - minV) * i / 4)), 6, yy + 3);
  }
  for (let i = 0; i <= 4; i++) { const x = 42 + ((W - 48) * i / 4); ctx.fillText(clock(minT + range * i / 4), x, H - 6); }

  const X = t => 42 + ((W - 48) * ((t - minT) / range));
  const Y = v => H - ((H - 24) * ((v - minV) / (maxV - minV)));
  for (const tr of traces) {
    const step = Math.max(1, Math.ceil(tr.pts.length / (W - 48)));
    ctx.strokeStyle = tr.color; ctx.lineWidth = 1.5; ctx.beginPath();
    let pen = false;
    for (let i = 0; i < tr.pts.length; i += step) {
      const px = X(tr.pts[i].t), py = Y(tr.pts[i].v);
      if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function drawAll() { for (const def of PLOT_DEFS) draw(def); }

// ---- events ----
function onMetrics(m) {
  lastMap[m.node_id] = m;
  const nums = nodeNumbers(m);
  lastNums[m.node_id] = nums;
  if (m.node_id === "head") vllm = m.vllm || null;
  for (const key of ALL_KEYS) push(m.node_id, key, m.ts, nums[key]);
  setStatus(lastNums.head ? lastNums.head.up : false, lastNums.worker ? lastNums.worker.up : undefined);
  updateBadge();
  refreshUI();
}

// Rebuild tiles if in hide mode and the set of available metrics has grown,
// refresh plot visibility, then redraw.
function refreshUI() {
  if (!showUnavail && availChanged()) buildTiles(view);
  updatePlotsVisibility();
  updateTiles();
  updateAlarms();
  scheduleDraw();
}

// In hide mode, drop a plot entirely (display:none) when every one of its
// metrics is unavailable, so we don't leave an empty canvas.
function updatePlotsVisibility() {
  for (const def of PLOT_DEFS) {
    const plotEl = document.getElementById(def.canvas).closest(".plot");
    if (!plotEl) continue;
    const anyAvail = def.keys.some(k => isAvailable(k));
    plotEl.style.display = anyAvail ? "" : "none";
  }
}

function setView(v) {
  view = v;
  hiddenTraces.clear();
  document.getElementById("view-per").classList.toggle("active", v === "per");
  document.getElementById("view-agg").classList.toggle("active", v === "agg");
  buildTiles(v); updatePlotsVisibility(); updateTiles(); drawAll();
}

function setShowUnavail(v) {
  showUnavail = v;
  lastAvailSig = "";
  document.getElementById("unav-hide").classList.toggle("active", !v);
  document.getElementById("unav-show").classList.toggle("active", v);
  try { localStorage.setItem("dash-unavail", v ? "show" : "hide"); } catch (e) { /* private browsing */ }
  buildTiles(view); updatePlotsVisibility(); updateTiles(); drawAll();
}

function markPoll(ms) { document.querySelectorAll("[data-poll]").forEach(b => b.classList.toggle("active", parseInt(b.dataset.poll) === ms)); }

let drawScheduled = false;
function scheduleDraw() { if (drawScheduled) return; drawScheduled = true; requestAnimationFrame(() => { drawScheduled = false; drawAll(); }); }

// ---- window selector ----
function setWindow(sec) {
  timeWindow = sec;
  document.querySelectorAll("[data-win]").forEach(b => b.classList.toggle("active", parseInt(b.dataset.win) === sec));
  try { localStorage.setItem("dash-window", String(sec)); } catch (e) { /* private browsing */ }
  drawAll();
}

// ---- threshold alerts ----
// Aggregated value used for the one-card (view=agg) alarm check.
function aggVal(key) {
  const def = METRICS.find(m => m.key === key);
  if (!def) return null;
  const hv = lastNums.head ? lastNums.head[key] : null, wv = lastNums.worker ? lastNums.worker[key] : null;
  if (hv != null && wv != null) return def.agg === "sum" ? hv + wv : (hv + wv) / 2;
  if (hv != null) return hv; if (wv != null) return wv;
  return null;
}

function maybeNotify(key) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const def = METRICS.find(m => m.key === key);
    new Notification("⚠ " + (def ? def.label : key) + " over threshold", { body: "node crossed your alert level", silent: true });
  } catch (e) { /* ignore */ }
}

function updateAlarms() {
  if (view === "agg") {
    for (const key of TILE_METRIC_KEYS) {
      const t = thresholds[key]; const ref = tileRefs[key]; if (!ref) continue;
      const over = t != null && (v => v != null && v > t)(aggVal(key));
      tieAlarm(ref.agg, key, over);
    }
  } else {
    for (const key of TILE_METRIC_KEYS) {
      const t = thresholds[key]; const ref = tileRefs[key]; if (!ref) continue;
      let over = false;
      for (const node of NODES) { const v = lastNums[node] ? lastNums[node][key] : null; if (t != null && v != null && v > t) over = true; }
      tieAlarm(ref.head || ref.worker, key, over);
    }
  }
}

function tieAlarm(cell, key, over) {
  const cardEl = cell.closest(".card"); if (!cardEl) return;
  cardEl.classList.toggle("alarm", over);
  if (over && !alerting[key]) { alerting[key] = true; maybeNotify(key); }
  if (!over) alerting[key] = false;
}

function saveThresholds() { try { localStorage.setItem("dash-thresholds", JSON.stringify(thresholds)); } catch (e) { /* private browsing */ } }

function buildAlertsPanel() {
  const list = document.getElementById("alerts-list"); list.innerHTML = "";
  for (const m of METRICS) {
    const row = el("div", "alert-row");
    row.appendChild(el("span", "", m.label + (m.unit ? " (" + m.unit + ")" : "")));
    const inp = document.createElement("input");
    inp.type = "number"; inp.step = "any"; inp.min = "0"; inp.placeholder = "off";
    if (thresholds[m.key] != null) inp.value = thresholds[m.key];
    inp.addEventListener("change", () => {
      const raw = parseFloat(inp.value);
      if (isFinite(raw) && raw > 0) { thresholds[m.key] = raw; requestNotifPermission(); }
      else delete thresholds[m.key];
      saveThresholds(); updateAlarms();
    });
    row.appendChild(inp); list.appendChild(row);
  }
}

function requestNotifPermission() {
  try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch (e) { /* ignore */ }
}

function toggleAlertsPanel() {
  alertsOpen = !alertsOpen;
  document.getElementById("alerts-panel").hidden = !alertsOpen;
  document.getElementById("alerts-toggle").classList.toggle("active", alertsOpen);
}

document.querySelectorAll("[data-poll]").forEach(b => b.addEventListener("click", () => {
  fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poll_ms: parseInt(b.dataset.poll) }) });
}));
document.getElementById("view-per").addEventListener("click", () => setView("per"));
document.getElementById("view-agg").addEventListener("click", () => setView("agg"));
document.getElementById("unav-hide").addEventListener("click", () => setShowUnavail(false));
document.getElementById("unav-show").addEventListener("click", () => setShowUnavail(true));
document.querySelectorAll("[data-win]").forEach(b => b.addEventListener("click", () => setWindow(parseInt(b.dataset.win))));
document.getElementById("alerts-toggle").addEventListener("click", toggleAlertsPanel);

// ---- themes (client-side only; persisted per browser, no server state) ----
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem("dash-theme", name); } catch (e) { /* private browsing */ }
}
const themeSel = document.getElementById("theme");
themeSel.addEventListener("change", () => applyTheme(themeSel.value));
(function initTheme() {
  let t = "default";
  try { t = localStorage.getItem("dash-theme") || "default"; } catch (e) { /* ignore */ }
  themeSel.value = t;
  applyTheme(t);
})();

(function initUnavail() {
  let v = false;
  try { v = (localStorage.getItem("dash-unavail") || "hide") === "show"; } catch (e) { /* ignore */ }
  showUnavail = v;
  document.getElementById("unav-hide").classList.toggle("active", !v);
  document.getElementById("unav-show").classList.toggle("active", v);
})();

(function initWindow() {
  let w = 0;
  try { w = parseInt(localStorage.getItem("dash-window") || "0"); } catch (e) { /* ignore */ }
  if (!isFinite(w) || w < 0) w = 0;
  timeWindow = w;
  document.querySelectorAll("[data-win]").forEach(b => b.classList.toggle("active", parseInt(b.dataset.win) === w));
})();

(function initAlerts() {
  try {
    const t = JSON.parse(localStorage.getItem("dash-thresholds") || "{}");
    for (const k in t) if (t[k] != null && t[k] > 0) thresholds[k] = t[k];
  } catch (e) { /* ignore */ }
  buildAlertsPanel();
})();

buildTiles(view);

// ---- wire up ----
const es = new EventSource("/api/metrics/push");
es.addEventListener("hello", e => { const c = JSON.parse(e.data); markPoll(c.poll_ms); setView(view); });
es.addEventListener("config", e => { const c = JSON.parse(e.data); markPoll(c.poll_ms); });
es.addEventListener("metrics", e => { try { onMetrics(JSON.parse(e.data)); } catch (err) { /* ignore malformed frame */ } });
es.onerror = () => setStatus(lastNums.head ? lastNums.head.up : false, lastNums.worker ? lastNums.worker.up : undefined);
