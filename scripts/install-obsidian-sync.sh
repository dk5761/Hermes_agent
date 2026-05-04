#!/usr/bin/env bash
# install-obsidian-sync.sh — idempotent installer for the headless
# Obsidian Sync client on the VPS (native systemd, no Docker).
#
# What it does (each step is safe to re-run):
#   1. Installs Node.js 22 if missing (NodeSource apt repo).
#   2. Installs/updates the global `obsidian-headless` npm package.
#   3. Creates the vault directory at $VAULT_DIR (default /opt/obsidian-vault).
#   4. Drops a systemd unit at /etc/systemd/system/obsidian-sync.service.
#   5. Patches hermes-dashboard.service to set OBSIDIAN_VAULT_PATH.
#   6. Runs scripts/patch-hermes-config.py to add `obsidian` to
#      platform_toolsets.cli in ~/.hermes/config.yaml.
#
# What it does NOT do (interactive — must be run by a human at the terminal):
#   - `ob login`           (email + password + MFA)
#   - `ob sync-setup`      (selects which remote vault to bind)
#   The script PRINTS the exact commands to run when those steps are missing
#   and exits cleanly. Re-run after completing them and it'll finish setup.
#
# Usage (run on the VPS as root):
#   sudo bash /root/repos/Hermes_agent/scripts/install-obsidian-sync.sh
#
# Override defaults via env:
#   VAULT_DIR=/srv/obsidian-vault VAULT_NAME="My Vault" \
#     sudo -E bash scripts/install-obsidian-sync.sh

set -euo pipefail

VAULT_DIR="${VAULT_DIR:-/opt/obsidian-vault}"
VAULT_NAME="${VAULT_NAME:-Drshnk}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SERVICE_NAME="obsidian-sync"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
HERMES_DASHBOARD_SERVICE="/etc/systemd/system/hermes-dashboard.service"
HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }

step() { c_blue "==> $*"; }

if [[ "${EUID}" -ne 0 ]]; then
  c_red "must run as root (or via sudo)"
  exit 1
fi

# ─── Step 1: Node.js 22 ──────────────────────────────────────────────────────
step "Step 1: Node.js ${NODE_MAJOR}"

needs_node=0
if ! command -v node >/dev/null 2>&1; then
  needs_node=1
else
  current_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  if [[ "${current_major}" -lt "${NODE_MAJOR}" ]]; then
    c_yellow "  found node v${current_major}; upgrading to v${NODE_MAJOR}"
    needs_node=1
  else
    c_green "  node $(node --version) ok"
  fi
fi

if [[ "${needs_node}" -eq 1 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  c_green "  installed $(node --version)"
fi

# ─── Step 2: obsidian-headless npm package ───────────────────────────────────
step "Step 2: obsidian-headless"

if command -v ob >/dev/null 2>&1; then
  c_green "  ob $(ob --version 2>&1 | head -1) already installed"
else
  npm install -g obsidian-headless
  c_green "  installed $(ob --version 2>&1 | head -1)"
fi

# ─── Step 3: vault directory ─────────────────────────────────────────────────
step "Step 3: vault directory ${VAULT_DIR}"

mkdir -p "${VAULT_DIR}"
chown -R root:root "${VAULT_DIR}"
c_green "  ${VAULT_DIR} exists"

# ─── Step 4: ob login + sync-setup (interactive — bail with instructions) ────
step "Step 4: Obsidian login + vault setup"

# `ob` stores creds in /root/.config/obsidian-headless/auth_token.
# `ob sync-list-remote` will fail if not logged in.
if ! ob sync-list-remote >/dev/null 2>&1; then
  c_yellow ""
  c_yellow "  Not logged in. Run interactively:"
  c_yellow ""
  c_yellow "    ob login"
  c_yellow ""
  c_yellow "  Enter email, password, and MFA. Then re-run THIS script."
  exit 2
fi
c_green "  logged in"

# Vault setup is detected by checking for ${VAULT_DIR}/.obsidian-headless/state.json
# or similar. The simplest reliable check: `ob sync` reports "no vault configured"
# if not set up. We just check for the marker dir created on first sync.
if [[ ! -d "${VAULT_DIR}/.obsidian" ]]; then
  c_yellow ""
  c_yellow "  Vault not bound yet. Run interactively:"
  c_yellow ""
  c_yellow "    cd ${VAULT_DIR}"
  c_yellow "    ob sync-setup --vault \"${VAULT_NAME}\""
  c_yellow "    ob sync                            # one-shot to verify decrypt works"
  c_yellow ""
  c_yellow "  Then re-run THIS script to install the systemd unit."
  exit 3
fi
c_green "  vault ${VAULT_NAME} bound to ${VAULT_DIR}"

# ─── Step 5: systemd unit ────────────────────────────────────────────────────
step "Step 5: systemd unit ${SERVICE_FILE}"

read -r -d '' DESIRED_UNIT <<EOF || true
[Unit]
Description=Obsidian Sync (headless) — keeps ${VAULT_DIR} in sync with Obsidian Sync cloud
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${VAULT_DIR}
ExecStart=/usr/bin/ob sync --continuous
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
# Credentials from \`ob login\` are cached under /root/.config/obsidian-headless/.

[Install]
WantedBy=multi-user.target
EOF

current_unit="$(cat "${SERVICE_FILE}" 2>/dev/null || true)"
if [[ "${current_unit}" == "${DESIRED_UNIT}" ]]; then
  c_green "  unit already up to date"
else
  printf '%s\n' "${DESIRED_UNIT}" > "${SERVICE_FILE}"
  systemctl daemon-reload
  c_green "  wrote ${SERVICE_FILE}"
fi

systemctl enable "${SERVICE_NAME}" >/dev/null 2>&1
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  systemctl restart "${SERVICE_NAME}"
  c_green "  restarted (was running)"
else
  systemctl start "${SERVICE_NAME}"
  c_green "  started"
fi

# ─── Step 6: hermes-dashboard.service env ────────────────────────────────────
step "Step 6: OBSIDIAN_VAULT_PATH on hermes-dashboard.service"

if [[ ! -f "${HERMES_DASHBOARD_SERVICE}" ]]; then
  c_yellow "  ${HERMES_DASHBOARD_SERVICE} not found — skipping (run hermes deploy first)"
else
  desired_env_line="Environment=OBSIDIAN_VAULT_PATH=${VAULT_DIR}"
  if grep -qF "${desired_env_line}" "${HERMES_DASHBOARD_SERVICE}"; then
    c_green "  already set"
  else
    # Insert after [Service] section header, idempotent. We check first to
    # avoid duplicates if a partial line already exists.
    if grep -qE '^Environment=OBSIDIAN_VAULT_PATH=' "${HERMES_DASHBOARD_SERVICE}"; then
      sed -i "s|^Environment=OBSIDIAN_VAULT_PATH=.*|${desired_env_line}|" "${HERMES_DASHBOARD_SERVICE}"
      c_green "  updated existing line"
    else
      sed -i "/^\[Service\]/a ${desired_env_line}" "${HERMES_DASHBOARD_SERVICE}"
      c_green "  inserted new line"
    fi
    systemctl daemon-reload
    c_yellow "  hermes-dashboard.service env changed — restart needed:"
    c_yellow "    systemctl restart hermes-dashboard"
  fi
fi

# ─── Step 7: patch-hermes-config.py ──────────────────────────────────────────
step "Step 7: enable obsidian toolset in ${HERMES_HOME}/config.yaml"

if [[ ! -f "${HERMES_HOME}/config.yaml" ]]; then
  c_yellow "  ${HERMES_HOME}/config.yaml not found — skipping"
else
  python3 "${REPO_ROOT}/scripts/patch-hermes-config.py" --config "${HERMES_HOME}/config.yaml"
fi

# ─── Done ────────────────────────────────────────────────────────────────────
c_green ""
c_green "Done."
c_green ""
c_green "Status:"
systemctl --no-pager --lines=3 status "${SERVICE_NAME}" 2>&1 | head -10 || true
c_green ""
c_green "Live logs:"
c_green "  journalctl -u ${SERVICE_NAME} -f"
c_green ""
c_green "Verify Hermes sees the vault:"
c_green "  ls ${VAULT_DIR}"
c_green "  systemctl restart hermes-dashboard   # only if step 6 changed env"
