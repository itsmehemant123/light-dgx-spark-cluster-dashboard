# Light DGX Spark Cluster Dashboard

Ultra-lightweight, real-time monitoring for a dual-node NVIDIA DGX Spark (GB10)
cluster. One small static Go binary serves a single-page dashboard from the
**head node** using only Server-Sent Events — no Prometheus, Grafana, Node.js
runtime, databases, or metric persistence. The browser accumulates and plots
time series, so server RAM stays flat regardless of how long a tab is open.

## Architecture

```
HEAD node (dashboard host)                  WORKER node
  dash-serve (Go, ~10 MB static)  ──ssh──▶  embedded collect script
    ├─ local subprocess ──▶ collect_script.sh  (head's own metrics)
    ├─ persistent SSH session ─────────────▶ collect_script.sh (worker metrics)
    ├─ scrape http://127.0.0.1:8000/metrics  (vLLM, for LIVE/tokens badge)
    └─ SSE fan-out  ──▶ browsers (no server-side history, no DB)
```

- One embedded bash collect script runs against **either** node (local subprocess
  on head, single reused SSH connection for worker). Its tagged output is parsed
  by one Go function into `NodeMetrics`.
- The server is a **stateless pass-through**: every poll tick it reads a full
  per-node snapshot and pushes it to every connected browser. Nothing is stored.

## Metrics gathered per node

All optional sources degrade gracefully — missing sources are shown as **N/A**:

| Source | What | Availability |
|---|---|---|
| `nvidia-smi` | per-GPU **util**, **power**, **temp**, **graphics/SM clocks** | standard |
| `nvidia-smi` | gpu **mem** total/used/%, **memory temp**, **mem clock** | **GB10: unavailable** (unified LPDDR5X — see note below) |
| `/sys/class/thermal/thermal_zone*` | SoC / CPU package temp (the 95–100 °C zone) | Linux |
| `/proc/stat`, `/proc/meminfo` | CPU %, RAM % (RAM reflects the shared LPDDR5X pool) | Linux |
| `/sys/class/hwmon/*` (`spark_hwmon`) | 8 temps + 14 power channels + fans | if driver installed |
| `/sys/devices/.../cpufreq` | CPU clock (kHz→MHz) | Linux |
| `nvme smart-log` | NVMe drive temp | if `nvme` + device |
| `http://127.0.0.1:8000/metrics` | vLLM tokens/s, active requests (head only) | if vLLM running |

> **GB10 GPU memory note.** DGX Spark uses one pool of unified LPDDR5X shared by the
> CPU and GPU, so `nvidia-smi` reports GPU memory usage (**`Not Supported`**) as well as
> **memory temperature** and the **memory clock** as **N/A**. The dashboard emits these as
> `null` (shown as **N/A**), and system RAM (`/proc/meminfo`) already reflects the shared
> pool — so the **RAM** tile is the authoritative memory figure. Use the **unavailable**
> control (default: *hide*) in the UI to either hide or show these tiles.

## Build & run (dev, on the head node)

Requires Go 1.22+ on the head node (or build the binary anywhere and copy it over).

```bash
./start-dashboard.sh            # builds (if needed) and runs with defaults
# open http://127.0.0.1:8088
```

Default settings (override with env vars): binds `127.0.0.1:8088`, polls every
`5000 ms`, worker `192.168.100.11` as user `root`, vLLM at
`http://127.0.0.1:8000/metrics`.

To run the full stack without DGX hardware (e.g. on a laptop) use **demo mode**:

```bash
DASH_DEMO=1 ./start-dashboard.sh
```

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `DASH_BIND` | `127.0.0.1:8088` | listen address (`0.0.0.0:8088` to expose directly) |
| `DASH_POLL_MS` | `5000` | poll/SSE interval (200–30000) |
| `DASH_WORKER_IP` | `192.168.100.11` | worker host |
| `DASH_WORKER_SSH_PORT` | `22` | worker ssh port |
| `DASH_WORKER_USER` | `root` | ssh user on worker (must be passwordless) |
| `DASH_VLLM_ENDPOINT` | `http://127.0.0.1:8000/metrics` | vLLM Prometheus metrics URL |
| `DASH_NO_WORKER` | `0` | set `1` to skip the worker entirely |
| `DASH_INSECURE_SKIP_HOSTKEY` | `0` | set `1` to skip SSH host-key checks |
| `DASH_DEMO` | `0` | synthetic data (no hardware) |

## Cross-compile for the head node

```bash
GOOS=linux GOARCH=arm64 go build -o dash-serve-linux-arm64 .
# copy the single file to the head node (e.g. /opt/dash/dash-serve)
```

## Deployment (head node service)

1. Build/copy the binary to `/opt/dash/dash-serve`.
2. Create a low-privilege user and ensure it can reach the worker passwordlessly
   and read GPU/sysfs (read `dash-serve.service` for exact steps):
   ```bash
   sudo useradd --system --create-home --shell /usr/sbin/nologin dashdash
   ```
3. Install the service:
   ```bash
   sudo cp dash-serve.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now dash-serve
   ```
4. (Optional) Reverse-proxy on the LAN with nginx — install `nginx-dash.conf`
   (SSE buffering is already off and read timeout is long):
   ```bash
   sudo cp nginx-dash.conf /etc/nginx/sites-available/dash
   sudo ln -sf /etc/nginx/sites-available/dash /etc/nginx/sites-enabled/dash
   sudo nginx -t && sudo systemctl reload nginx
   # uncomment auth_basic lines + htpasswd if you want a password
   ```

## API

- `GET /api/metrics/push` — SSE stream. `hello` event on connect with current
  `poll_ms`; then repeated `metrics` events (one per node per tick):
  ```json
  { "node_id":"head","ts":1786065220.44,"up":true,"source":"local:sysfs+nvidia-smi",
    "gpu":[{ "idx":0,"util_pct":83,"mem_pct":null,"power_w":92,"temp_c":66,"mem_temp_c":null,
             "clock_graphics_mhz":1185,"clock_mem_mhz":null,"name":"GB10" }],
    "soc_temp_c":96.5,"cpu_pct":14,"ram":{ "total_mb":196412,"used_mb":41436,"pct":21 },
    "power":{ "sys_total":335,"gpu_total":176 },"temps":{ "soc_pkg":96.5 },
    "fans":{ "fan0":2369 },"nvme_temp_c":49,"cpu_clk_mhz":2400,
    "vllm":{ "reachable":false,"running_requests":-1,"gen_tokens_rate":-1 } }
  ```
  Missing sources are `null`/absent — e.g. on GB10 the GPU **memory** fields,
  **memory temp** (`mem_temp_c`) and **mem clock** (`clock_mem_mhz`) are `null`
  (see the metrics note above); a down worker sends `"up":false` with an
  `error` field while the head keeps streaming.
- `GET /api/config` / `POST /api/config` — read/set `{"poll_ms": <ms>}`. Changing
  it broadcasts a `config` event so every open tab updates its controls.
- `GET /` — the dashboard page (self-contained HTML/JS/CSS, embedded in the binary).

## Frontend notes

- Tiles show current values; the **view toggle** switches between per-node and
  aggregated (summed/averaged, clearly labeled).
- The **unavailable toggle** hides (default) or shows metrics the current
  hardware doesn't report (e.g. GB10 GPU memory / memory temp / mem clock);
  hidden plots are removed rather than left blank. Persisted per browser.
- The **LIVE badge** lights when vLLM is generating (tokens/s + active requests)
  or, as a fallback, on a GPU power/utilization spike.
- Four canvas plots (tile-free, downsampled to canvas width) show temperature,
  power, clocks, and utilization over time.
- Buffers are client-side: a fine ring capped at ~3600 points per series that
  **decimates-by-2** when full, so the tab never balloons over hours. Poll rate
  is adjustable right in the UI (250 ms–5 s).

## Footprint

| Item | Estimate |
|---|---|
| Binary (static) | ~10 MB disk |
| Server RSS | ~10–20 MB |
| Per connected browser | a few KB (no buffering) |
| Per poll | 2× `nvidia-smi` + 2 light shell execs (1 local + 1 over the reused SSH session) |

## Troubleshooting

- **Worker shows OFFLINE**: check ssh `root@192.168.100.11` works from the run
  user; check `DASH_WORKER_USER`/`IP`; if host-key errors, run once as that user
  to accept the host key, or set `DASH_INSECURE_SKIP_HOSTKEY=1`.
- **Tiles show N/A**: that driver/sensor isn't exposed on the node (e.g.
  `spark_hwmon` not installed). Everything still works with what's available.
- **vLLM badge stays dark**: confirm the OpenAI-compatible server serves
  [Prometheus] at `DASH_VLLM_ENDPOINT`; the GPU-spike fallback still works.

## Tests

```bash
go test ./...          # collector parser, CPU/mem/soc derivation, SSE + config endpoints
go vet ./...
```

## Notes / limitations

- The dashboard and vLLM share the head node; by design the server holds no
  history and ~10–20 MB RSS so it does not starve the serving workload.
- Aggregated view is computed client-side from the two per-node streams.
- Instantaneous `spark_hwmon` power oscillates (100 ms firmware PID); the tiled
  value is the latest sample and the plot shows its trend over time.
