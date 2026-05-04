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

set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
SKIP_UPDATE="${SKIP_UPDATE:-0}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
step()     { c_blue "==> $*"; }
ok()       { c_green "  ✓ $*"; }

if [[ "${EUID}" -ne 0 ]]; then c_red "must run as root (or via sudo)"; exit 1; fi

# ─── Step 1: hermes update ───────────────────────────────────────────────────
if [[ "${SKIP_UPDATE}" == "1" ]]; then
  step "Step 1/4: hermes update — SKIPPED (SKIP_UPDATE=1)"
else
  step "Step 1/4: hermes update"
  hermes update
  ok "agent up to date"
fi

# ─── Step 2: re-apply config patches ─────────────────────────────────────────
step "Step 2/4: patch-hermes-config.py (re-apply mcp_servers + platform_toolsets)"
if [[ ! -f "${HERMES_HOME}/config.yaml" ]]; then
  c_red "  ${HERMES_HOME}/config.yaml not found"
  exit 1
fi
python3 "${REPO_ROOT}/scripts/patch-hermes-config.py" --config "${HERMES_HOME}/config.yaml"

# ─── Step 3: restart dashboard + gateway (in order) ──────────────────────────
step "Step 3/4: restart hermes-dashboard then hermes-gateway"
systemctl restart hermes-dashboard
sleep 3
systemctl restart hermes-gateway
ok "both restarted"

# ─── Step 4: verify ──────────────────────────────────────────────────────────
step "Step 4/4: verify"
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

c_green ""
c_green "Done. Open the mobile app and try a chat. If it hangs, paste"
c_green "  journalctl -u hermes-gateway --since '2 minutes ago' --no-pager | tail -30"
