#!/usr/bin/env bash
# post-hermes-update.sh — run after `hermes update` (or run instead of it
# if you want one command for the whole flow).
#
# Why this exists:
#   - Hermes' version migrator may strip or overwrite our mcp_servers /
#     platform_toolsets entries during version bumps. patch-hermes-config.py
#     is idempotent — re-running re-installs them.
#   - Restart order matters: dashboard restart first (rotates the in-memory
#     _SESSION_TOKEN), then gateway (re-scrapes the new token from
#     /index.html). A bare dashboard restart leaves the gateway holding a
#     stale token and every chat hangs with `upstream_ws_open_failed`.
#
# Usage:
#   sudo bash /root/repos/Hermes_agent/scripts/post-hermes-update.sh
#   sudo HERMES_HOME=/custom/path bash scripts/post-hermes-update.sh
#   sudo SKIP_UPDATE=1 bash scripts/post-hermes-update.sh   # patch + restart only
#   sudo SKIP_SNAPSHOT=1 bash scripts/post-hermes-update.sh # skip pre-update snapshot

set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
SKIP_UPDATE="${SKIP_UPDATE:-0}"
SKIP_SNAPSHOT="${SKIP_SNAPSHOT:-0}"
SNAPSHOT_SCRIPT="${SNAPSHOT_SCRIPT:-/root/hermes-snapshot.sh}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
step()     { c_blue "==> $*"; }
ok()       { c_green "  ✓ $*"; }

UPDATE_STARTED=0

unit_exists() {
  local unit="$1"
  local state
  state="$(systemctl show -p LoadState --value "${unit}.service" 2>/dev/null || true)"
  [[ -n "$state" && "$state" != "not-found" ]]
}

restart_stack() {
  systemctl restart hermes-dashboard
  sleep 3
  systemctl restart hermes-gateway
  sleep 2
  if unit_exists hermes-cron; then
    systemctl restart hermes-cron
    ok "all three restarted"
  else
    ok "dashboard + gateway restarted (hermes-cron not installed)"
  fi
}

on_error() {
  local rc=$?
  trap - ERR
  c_red "post-hermes-update failed (exit ${rc})"
  if [[ "${UPDATE_STARTED}" == "1" ]]; then
    c_yellow "  update/patch flow had started; attempting service restart before exit"
    restart_stack || true
  fi
  exit "$rc"
}

trap on_error ERR

if [[ "${EUID}" -ne 0 ]]; then c_red "must run as root (or via sudo)"; exit 1; fi

# ─── Step 1: hermes update ───────────────────────────────────────────────────
if [[ "${SKIP_SNAPSHOT}" == "1" ]]; then
  step "Step 0/5: pre-update snapshot — SKIPPED (SKIP_SNAPSHOT=1)"
else
  step "Step 0/5: pre-update snapshot"
  if [[ -x "${SNAPSHOT_SCRIPT}" ]]; then
    bash "${SNAPSHOT_SCRIPT}"
    ok "snapshot completed"
  else
    c_yellow "  snapshot script not executable or missing: ${SNAPSHOT_SCRIPT}"
    c_yellow "  continuing; set SNAPSHOT_SCRIPT=/path/to/script or SKIP_SNAPSHOT=1 to silence"
  fi
fi

if [[ "${SKIP_UPDATE}" == "1" ]]; then
  step "Step 1/5: hermes update — SKIPPED (SKIP_UPDATE=1)"
else
  step "Step 1/5: hermes update"
  UPDATE_STARTED=1
  hermes update
  ok "agent up to date"
fi

# ─── Step 2: re-apply config + source patches ───────────────────────────────
step "Step 2/5: patch-hermes-config.py (re-apply mcp_servers + platform_toolsets)"
if [[ ! -f "${HERMES_HOME}/config.yaml" ]]; then
  c_red "  ${HERMES_HOME}/config.yaml not found"
  exit 1
fi
python3 "${REPO_ROOT}/scripts/patch-hermes-config.py" --config "${HERMES_HOME}/config.yaml"
python3 "${REPO_ROOT}/scripts/patch-hermes-config.py" --config "${HERMES_HOME}/config.yaml" --check

step "Step 2b/5: patch-hermes-reload-mcp.py (Python source — clear caches on /reload-mcp)"
python3 "${REPO_ROOT}/scripts/patch-hermes-reload-mcp.py"
python3 "${REPO_ROOT}/scripts/patch-hermes-reload-mcp.py" --check

step "Step 2bb/5: patch-hermes-slash-history.py (preload transcript in slash worker)"
python3 "${REPO_ROOT}/scripts/patch-hermes-slash-history.py"
python3 "${REPO_ROOT}/scripts/patch-hermes-slash-history.py" --check

step "Step 2c/5: patch-hermes-stt-rpc.py (server-side STT RPC)"
python3 "${REPO_ROOT}/scripts/patch-hermes-stt-rpc.py"
python3 "${REPO_ROOT}/scripts/patch-hermes-stt-rpc.py" --check

step "Step 2d/5: deploy custom skills"
if [[ -d "${REPO_ROOT}/scripts/skills" ]]; then
  for src in "${REPO_ROOT}"/scripts/skills/*/SKILL.md; do
    [[ -f "$src" ]] || continue
    name="$(basename "$(dirname "$src")")"
    dest="${HERMES_HOME}/skills/${name}"
    mkdir -p "$dest"
    cp "$src" "$dest/SKILL.md"
    ok "deployed skill: ${name}"
  done
fi

# ─── Step 3: restart dashboard + gateway + cron (in order) ───────────────────
step "Step 3/5: restart hermes-dashboard, hermes-gateway, hermes-cron"
# `hermes update` (Step 1) deactivates hermes-cron without triggering systemd's
# Restart=on-failure (clean exit). MCP servers live under hermes-cron, so
# without this restart the agent has zero MCP tools after every update.
restart_stack

# ─── Step 4: verify ──────────────────────────────────────────────────────────
step "Step 4/5: verify"
sleep 2

if ! systemctl is-active --quiet hermes-dashboard; then
  c_red "  hermes-dashboard not active:"
  systemctl --no-pager --lines=10 status hermes-dashboard | head -15
  exit 1
fi
ok "hermes-dashboard active"

if ! systemctl is-active --quiet hermes-gateway; then
  c_red "  hermes-gateway not active:"
  systemctl --no-pager --lines=10 status hermes-gateway | head -15
  exit 1
fi
ok "hermes-gateway active"

if unit_exists hermes-cron; then
  if ! systemctl is-active --quiet hermes-cron; then
    c_red "  hermes-cron not active (MCP servers + cron jobs won't fire):"
    systemctl --no-pager --lines=10 status hermes-cron | head -15
    exit 1
  fi
  ok "hermes-cron active"
fi

# Local health check via gateway
local_health="$(curl -sS -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8080/health || echo 000)"
if [[ "${local_health}" == "200" ]]; then
  ok "gateway /health = 200"
else
  c_yellow "  gateway /health = ${local_health} (expected 200) — check journalctl -u hermes-gateway"
fi

# Upstream WS auth (token-scrape) sanity — if dashboard rotated token but
# gateway didn't re-scrape, this will fail. The post-update flow above
# handles it, so this is just confirmation.
upstream_status="$(curl -sS -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:9119/api/status || echo 000)"
if [[ "${upstream_status}" == "200" ]]; then
  ok "hermes /api/status = 200"
else
  c_yellow "  hermes /api/status = ${upstream_status}"
fi

step "Step 5/5: doctor"
bash "${REPO_ROOT}/scripts/doctor.sh"

c_green ""
c_green "Done. Open the mobile app and try a chat. If it hangs, paste"
c_green "  journalctl -u hermes-gateway --since '2 minutes ago' --no-pager | tail -30"
