# Dashboard user setup (dedicated `dashdash` account)

This installs a low-privileged `dashdash` system user that runs the dashboard and
reaches the worker **passwordlessly** with its own SSH identity — kept fully
separate from the `nvidia` admin account (which the dashboard never uses).

The instructions in this file match what `light-dgx-spark-cluster-dashboard.service`, `ssh.go` and
`main.go` actually expect:

- The service runs as **`dashdash`** with `WorkingDirectory=/opt/dash` and
  `ExecStart=/opt/dash/light-dgx-spark-cluster-dashboard` (`light-dgx-spark-cluster-dashboard.service`).
- SSH auth uses the **run user's** `~/.ssh/id_ed25519` (then `id_ecdsa`, then
  `id_rsa`), or the `SSH_AUTH_SOCK` ssh-agent (`ssh.go`).
- Host keys are checked from the run user's `~/.ssh/known_hosts` (`ssh.go`).
- The remote command is `bash` with the collect script on **stdin** — so the
  **worker-side** user must have a **real shell** (not `nologin`) (`ssh.go`).
- Worker credentials come from env vars (`DASH_WORKER_USER`, `DASH_WORKER_IP`)
  defined in the service unit (`main.go`).

## Layout

- **HEAD node** = dashboard host = `192.168.100.10`
- **WORKER node** = other Spark = `192.168.100.11`

> These are **placeholder addresses** used consistently across the code, scripts,
> service unit, and docs. Replace them with your actual nodes' addresses before
> following the production steps below.

---

## HEAD NODE (192.168.100.10)

### 1. Create the low-privileged system user
```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin dashdash
```
`--system` makes it a service account, `--create-home` gives it a `~/.ssh` home,
`nologin` means nobody logs in interactively. On the head this is safe: systemd
launches the binary directly and never uses a login shell.

### 2. Build the binary and install it to /opt/dash
Build it directly here (no need for a pre-existing artifact) by cross-compiling
from the repo checkout and writing straight to `/opt/dash`:
```bash
sudo mkdir -p /opt/dash
cd /path/to/repo                      # your local checkout of this repo
GOOS=linux GOARCH=arm64 go build -o /opt/dash/light-dgx-spark-cluster-dashboard .
sudo chown -R dashdash:dashdash /opt/dash
sudo chmod +x /opt/dash/light-dgx-spark-cluster-dashboard
```
(Alternatively, cross-compile with `go build -o light-dgx-spark-cluster-dashboard-linux-arm64 .`,
copy that single file to the head node, and place it at
`/opt/dash/light-dgx-spark-cluster-dashboard` — the section after step 2 below proceeds
the same way.)

### 3. Generate an SSH key for dashdash (the dashboard's own identity)
```bash
sudo -u dashdash ssh-keygen -t ed25519 -N "" -f ~dashdash/.ssh/id_ed25519
sudo cat ~dashdash/.ssh/id_ed25519.pub
```
Copy the printed public key — you'll paste it on the worker in step 5. This key
is decoupled from your `nvidia` user's keys and is the only credential the
dashboard uses.

### 4. Pre-authorize the worker's host key
Run the redirect **as root** (your own shell cannot write into `dashdash`'s home):
```bash
sudo sh -c 'ssh-keyscan 192.168.100.11 >> /home/dashdash/.ssh/known_hosts'
sudo chown dashdash:dashdash /home/dashdash/.ssh/known_hosts
```
> `~dashdash` expands to the home directory; replace `/home/dashdash` if
> `useradd` placed it elsewhere (check `getent passwd dashdash`).

---

## WORKER NODE (192.168.100.11)

### 5. Create dashdash here too — with a REAL shell (NOT nologin)
```bash
sudo useradd --system --create-home --shell /bin/bash dashdash
sudo mkdir -p /home/dashdash/.ssh
```
Why `bash`: the dashboard runs the collect script by feeding it to `bash`
remotely (`sess.Output("bash")`). A `nologin` shell would silently refuse that
command. `dashdash` gets **no sudo** and **no password**, so it remains
low-privilege — it only needs a shell to run the read-only collector.

### 6. Authorize the head's public key
```bash
# paste the key copied in step 3 (replace the placeholder):
sudo sh -c 'echo "PASTE_THE_DASHBOARD_PUBKEY_HERE" >> /home/dashdash/.ssh/authorized_keys'
sudo chmod 700 /home/dashdash/.ssh
sudo chmod 600 /home/dashdash/.ssh/authorized_keys
sudo chown -R dashdash:dashdash /home/dashdash/.ssh
```

---

## Back on HEAD NODE — verify passwordless access

### 7. Confirm dashdash can reach the worker passwordlessly
```bash
sudo -u dashdash ssh dashdash@192.168.100.11 'echo ok'
```
You should see `ok`. Then confirm the worker-side reads the collector needs:
```bash
sudo -u dashdash ssh dashdash@192.168.100.11 \
  'nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw --format=csv,noheader; head -1 /proc/stat; head -2 /proc/meminfo'
```
Notes:
- DGX sysfs/proc files are world-readable and `nvidia-smi` works for regular
  users, so no sudo is needed on the worker.
- If a source is not readable it is simply omitted and shows **N/A** — not an
  error. In particular `nvme smart-log` often needs root/`CAP_SYS_ADMIN`, so
  NVMe temp may legitimately show N/A for this low-priv user.

---

Installing and running the dashboard as a systemd service is covered in the main
**README's "Deployment (head node service)"** section. The
`light-dgx-spark-cluster-dashboard.service` unit ships preconfigured for the
low-priv `dashdash` worker (`DASH_WORKER_USER=dashdash`), so you won't need to
edit it unless your worker/SSH port differs.

---

## Worker hardening (optional but recommended)

Restrict the key in `authorized_keys` so it can only drive the collector and
can't open an interactive shell, forward ports, or request a PTY. On the worker,
prepend options to the line in `/home/dashdash/.ssh/authorized_keys`:

```
restrict,no-pty,no-port-forwarding,no-X11-forwarding,command="bash" ssh-ed25519 AAAAC3... dashdash@head
```

`restrict` alone disables port forwarding, PTY, X11 and agent forwarding. The
`command="bash"` makes sshd run `bash` (the collector feeds the script on stdin)
instead of any other requested command, so the key can't be used for arbitrary
commands like `id` or file reads.

> Note: this still grants a `bash` shell on stdin, but only as the no-sudo,
> no-password `dashdash` user, with no forwarding — it prevents using the key
> to reach anything else on the worker.

Verify after editing (the extra command should be ignored/swallowed):
```bash
sudo -u dashdash ssh dashdash@192.168.100.11 'echo should-be-swallowed'
sudo systemctl restart light-dgx-spark-cluster-dashboard   # ensure the collector still works
journalctl -u light-dgx-spark-cluster-dashboard -f         # worker tile should show data
```

---

## Security summary
- The `nvidia` user (sudo + password) is **untouched**; the dashboard never uses it.
- The dashboard has its own identity (`dashdash` → worker `dashdash`), so it can't
  touch sudo or cluster control on the worker.
- On the **head**, `dashdash` is `nologin`; on the **worker** it has `bash` (required
  to run the remote collector) but no sudo, no password, and (with hardening) a
  locked-down SSH key.
