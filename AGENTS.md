# AGENTS.md

Single Go `package main` app (Go 1.26, dep: `golang.org/x/crypto`) serving a
self-contained monitoring dashboard for a 2-node DGX Spark (GB10) cluster. No
framework, DB, or frontend build step. See `README.md` for full docs.

## Build / run / test

- `./start-dashboard.sh` — builds (if binary missing) and runs. Defaults bind
  `127.0.0.1:8088`, poll 5000ms, worker `192.168.100.11`.
- `DASH_DEMO=1 ./start-dashboard.sh` — synthetic data, no NVIDIA/Linux hardware
  needed. Always use this to test UI/SSE locally on a laptop.
- `go test ./...` — collector parser, CPU/mem/soc derivation, SSE + config
  endpoints. `go vet ./...` too. No fixtures or services required.
- Cross-compile for the head node: `GOOS=linux GOARCH=arm64 go build -o
  light-dgx-spark-cluster-dashboard-linux-arm64 .`

## Critical wiring (easy to miss)

- `static/` (frontend HTML/JS/CSS) and `collect_script.sh` are **embedded** via
  `//go:embed` in `main.go:18` and `collect.go:12`. Any edit to `static/` or
  `collect_script.sh` requires a **rebuild** — there is no dev server.
- `collect_script.sh` runs identically as a local subprocess (head) and over a
  reused SSH session (worker). Its `|`-delimited tagged line format is the
  contract parsed by `parseCollectOutput` in `collect.go:198`. If you add/reorder
  GPU or other fields in the script, you MUST update the parser and the `GPU`
  struct in the same commit, or parsing silently drops fields.
- Runtime config is **env-var only** (`DASH_*`, see README table); there is no
  config file. `POST /api/config` only changes `poll_ms` at runtime.
- Server is a stateless SSE pass-through: no history, no DB. Frontend accumulates
 / decimates buffers client-side. Don't add server-side metric storage.

## GB10 unavailable-metric convention (repo-specific)

On GB10, `nvidia-smi` reports GPU memory / memory temp / mem clock as unsupported.
Handle these as **`*float64` in the `GPU` struct** (JSON `null`, shown as N/A), not
plain `float64`:
- Parse via `fOpt()` in `collect.go:100`, which maps `""`, `NA`, `[N/A]`,
  `Not Supported` to `nil`.
- `collect_script.sh` already normalizes raw `[N/A]`/`NotSupported` to `NA`.
  Preserve this — missing sources must degrade to `null`, never a misleading `0`.
- `SocTempC`, `CPUClkMHz`, `NVMeTempC` follow the same `*float64` N/A convention.

## Deployment / ops

- Service unit `light-dgx-spark-cluster-dashboard.service` runs as low-priv
  `dashdash` user, `WorkingDirectory=/opt/dash`. The run user needs passwordless
  SSH to the worker; `dashdash` on the worker must have a shell. Full walkthrough
  in `user_setup.md`.
- `nginx-dash.conf`: the `/api/metrics/push` SSE location MUST keep
  `proxy_buffering off` and a long read timeout, or the stream breaks.
- Placeholder IPs `192.168.100.10` (head) / `.11` (worker) are used consistently
  across code, scripts, service unit, and docs — grep before changing.

## Conventions

- Plain `net/http` + `http.NewServeMux`; no routing lib. New endpoints: register
  in `main.go:354` `mux.HandleFunc`.
- No comments in code unless meaningful (existing code is lightly commented).
  Match the existing terse style.
- Commit binaries are gitignored (`/light-dgx-spark-cluster-dashboard*`); never
  `git add` build artifacts.
- Never `git commit` (or push, or create a PR) without asking the user first.
