#!/usr/bin/env bash
# Minimal launcher for the DGX Spark cluster dashboard (HEAD node).
# All settings come from environment variables; defaults are sane for the
# two-node DGX Spark layout (head=192.168.100.10, worker=192.168.100.11).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

DASH_BIND="${DASH_BIND:-127.0.0.1:8088}"
DASH_POLL_MS="${DASH_POLL_MS:-5000}"
DASH_WORKER_IP="${DASH_WORKER_IP:-192.168.100.11}"
DASH_WORKER_SSH_PORT="${DASH_WORKER_SSH_PORT:-22}"
DASH_WORKER_USER="${DASH_WORKER_USER:-root}"
DASH_VLLM_ENDPOINT="${DASH_VLLM_ENDPOINT:-http://127.0.0.1:8000/metrics}"

BIN="${DASH_BIN:-./light-dgx-spark-cluster-dashboard}"
if [ ! -x "$BIN" ]; then
  echo "building $BIN for $(go env GOOS)/$(go env GOARCH) ..." >&2
  go build -o "$BIN" .
fi

export DASH_BIND DASH_POLL_MS DASH_WORKER_IP DASH_WORKER_SSH_PORT DASH_WORKER_USER
export DASH_VLLM_ENDPOINT
# optional passthrough flags
: "${DASH_DEMO:=0}"; export DASH_DEMO
: "${DASH_INSECURE_SKIP_HOSTKEY:=0}"; export DASH_INSECURE_SKIP_HOSTKEY
: "${DASH_NO_WORKER:=0}"; export DASH_NO_WORKER

exec "$BIN" "$@"
