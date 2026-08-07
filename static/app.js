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
];

let view = "per";
let lastMap = {};
let lastNums = {};
let vllm = null;
let tileRefs = null;
const legendCache = {};

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
    fan: (m.fans && Object.keys(m.fans).length) ? Object.values(m.fans).map(v => Math.round(v)).join(" / ") : null,
    nvme: m.nvme_temp_c != null ? Math.round(m.nvme_temp_c) : null,
    up: m.up, source: m.source || "",
  };
}

// ---- series buffer ----
function push(node, key, t, v) {
  if (v == null || v === "") return;
  let a = series[node][key] || (series[node][key] = []);
  a.push({ t, v });
  if (a.length > FINE_CAP) {
    const out = [];
    for (let i = 0; i < a.length; i += 2) out.push(a[i]);
    if (out[out.length - 1].t !== a[a.length - 1].t) out.push(a[a.length - 1]);
    series[node][key] = out;
  }
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
  const metrics = METRICS.concat(EXTRA);
  for (const m of metrics) {
    const card = el("div", "card");
    card.appendChild(el("div", "lbl", m.label + " · " + m.unit));
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
function collectTraces(def) {
  const traces = [];
  if (view === "agg") {
    for (const key of def.keys) {
      const pts = aggSeries(key, def.mode === "sum" ? (a, b) => a + b : (a, b) => (a + b) / 2);
      if (pts.length) traces.push({ label: key, color: METRICS.find(m => m.key === key).color, pts });
    }
  } else {
    for (const key of def.keys) {
      const color = METRICS.find(m => m.key === key).color;
      for (const node of NODES) { const pts = series[node][key] || []; if (pts.length) traces.push({ label: key + "·" + node, color, pts }); }
    }
  }
  return traces.filter(tr => tr.pts.length);
}

function legendEl(canvasId) {
  if (legendCache[canvasId]) return legendCache[canvasId];
  const plot = document.getElementById(canvasId).closest(".plot");
  const l = el("div", "legend"); plot.appendChild(l); legendCache[canvasId] = l; return l;
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

  const traces = collectTraces(def);
  const leg = legendEl(def.canvas); leg.innerHTML = "";
  for (const tr of traces) { const s = el("span", ""); s.style.color = tr.color; s.textContent = tr.label; leg.appendChild(s); }

  let minT = Infinity, maxT = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const tr of traces) for (const p of tr.pts) { if (p.t < minT) minT = p.t; if (p.t > maxT) maxT = p.t; if (p.v < minV) minV = p.v; if (p.v > maxV) maxV = p.v; }
  if (!isFinite(minT) || traces.length === 0) {
    ctx.fillStyle = "#7d8b99"; ctx.textAlign = "center"; ctx.fillText("waiting for data…", W / 2, H / 2);
    return;
  }
  const pad = (maxV - minV) * 0.08 || 1; minV = Math.max(0, minV - pad); maxV = maxV + pad;
  if (maxV === minV) maxV = minV + 1;
  const range = (maxT - minT) || 1;

  ctx.strokeStyle = "#1c2733"; ctx.fillStyle = "#7d8b99"; ctx.font = "10px sans-serif"; ctx.lineWidth = 1;
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
  updateTiles();
  scheduleDraw();
}

function setView(v) {
  view = v;
  document.getElementById("view-per").classList.toggle("active", v === "per");
  document.getElementById("view-agg").classList.toggle("active", v === "agg");
  buildTiles(v); updateTiles(); drawAll();
}

function markPoll(ms) { document.querySelectorAll("[data-poll]").forEach(b => b.classList.toggle("active", parseInt(b.dataset.poll) === ms)); }

let drawScheduled = false;
function scheduleDraw() { if (drawScheduled) return; drawScheduled = true; requestAnimationFrame(() => { drawScheduled = false; drawAll(); }); }

document.querySelectorAll("[data-poll]").forEach(b => b.addEventListener("click", () => {
  fetch("/api/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ poll_ms: parseInt(b.dataset.poll) }) });
}));
document.getElementById("view-per").addEventListener("click", () => setView("per"));
document.getElementById("view-agg").addEventListener("click", () => setView("agg"));

buildTiles(view);

// ---- wire up ----
const es = new EventSource("/api/metrics/push");
es.addEventListener("hello", e => { const c = JSON.parse(e.data); markPoll(c.poll_ms); setView(view); });
es.addEventListener("config", e => { const c = JSON.parse(e.data); markPoll(c.poll_ms); });
es.addEventListener("metrics", e => { try { onMetrics(JSON.parse(e.data)); } catch (err) { /* ignore malformed frame */ } });
es.onerror = () => setStatus(lastNums.head ? lastNums.head.up : false, lastNums.worker ? lastNums.worker.up : undefined);
