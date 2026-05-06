#!/usr/bin/env bash
# install-vps.sh — one-shot bootstrap for a fresh Ubuntu 24+ VPS.
#
# Idempotent: safe to re-run any time. Each step is detected; only missing
# pieces are installed. The script bails with explicit instructions when it
# hits a step that genuinely needs human input (Hermes API key, gateway
# .env secrets, certbot TOS, ob login MFA). After completing the manual
# step, just re-run the script — it picks up where it left off.
#
# Pre-reqs:
#   - Fresh Ubuntu 24+ VPS, root SSH access
#   - DNS A record for $DOMAIN pointing at the VPS public IP
#
# Usage:
#   sudo bash /root/repos/Hermes_agent/scripts/install-vps.sh
#   sudo DOMAIN=hermes.example.com bash scripts/install-vps.sh
#   sudo SKIP_OBSIDIAN=1 bash scripts/install-vps.sh    # skip the Obsidian phase
#
# Env overrides:
#   DOMAIN          — public hostname (default: hermes.drshnk.dev)
#   REPO_URL        — git remote (default: git@github.com:dk5761/Hermes_agent.git)
#   REPO_DIR        — local clone path (default: /root/repos/Hermes_agent)
#   HERMES_HOME     — Hermes data dir (default: /root/.hermes)
#   NODE_MAJOR      — Node.js major version (default: 22)
#   SKIP_OBSIDIAN   — set 1 to skip the install-obsidian-sync.sh step
#   CERTBOT_EMAIL   — non-interactive certbot email (default: prompt-driven)

set -euo pipefail

DOMAIN="${DOMAIN:-hermes.drshnk.dev}"
REPO_URL="${REPO_URL:-git@github.com:dk5761/Hermes_agent.git}"
REPO_DIR="${REPO_DIR:-/root/repos/Hermes_agent}"
HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SKIP_OBSIDIAN="${SKIP_OBSIDIAN:-0}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
step()     { c_blue "==> $*"; }
ok()       { c_green "  ✓ $*"; }
warn()     { c_yellow "  ⚠ $*"; }

if [[ "${EUID}" -ne 0 ]]; then c_red "must run as root (or via sudo)"; exit 1; fi

# Track whether we made any change that warrants a final restart.
SERVICES_DIRTY=0

# ─── Step 1: apt packages ────────────────────────────────────────────────────
step "Step 1/11: base packages"

REQUIRED_PKGS=(curl git nginx python3-ruamel.yaml certbot python3-certbot-nginx ca-certificates)
to_install=()
for pkg in "${REQUIRED_PKGS[@]}"; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then to_install+=("$pkg"); fi
done
if [[ ${#to_install[@]} -gt 0 ]]; then
  apt-get update -qq
  apt-get install -y "${to_install[@]}"
  ok "installed: ${to_install[*]}"
else
  ok "all packages present"
fi

# ─── Step 2: Node.js + pnpm ──────────────────────────────────────────────────
step "Step 2/11: Node.js ${NODE_MAJOR} + pnpm"

needs_node=0
if ! command -v node >/dev/null 2>&1; then
  needs_node=1
else
  current_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
  [[ "${current_major}" -lt "${NODE_MAJOR}" ]] && needs_node=1
fi
if [[ "${needs_node}" -eq 1 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
  ok "installed $(node --version)"
else
  ok "node $(node --version) ok"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm
  ok "installed pnpm $(pnpm --version)"
else
  ok "pnpm $(pnpm --version) ok"
fi

# ─── Step 3: Hermes agent ────────────────────────────────────────────────────
step "Step 3/11: Hermes agent"

if ! command -v hermes >/dev/null 2>&1; then
  curl -fsSL https://hermes-agent.nousresearch.com/install.sh | sh
  if ! command -v hermes >/dev/null 2>&1; then
    c_red "  hermes installer ran but the binary wasn't found on PATH"
    exit 1
  fi
fi
ok "$(hermes --version 2>&1 | head -1)"

# ─── Step 4: clone repo ──────────────────────────────────────────────────────
step "Step 4/11: repo at ${REPO_DIR}"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  mkdir -p "$(dirname "${REPO_DIR}")"
  if ! git -c core.sshCommand="ssh -o StrictHostKeyChecking=accept-new" clone "${REPO_URL}" "${REPO_DIR}" 2>&1; then
    c_red "  clone failed — likely missing SSH key for ${REPO_URL}"
    c_yellow "  Generate one and add to GitHub:"
    c_yellow "    ssh-keygen -t ed25519 -C \"vps@$(hostname)\" -f /root/.ssh/id_ed25519 -N \"\""
    c_yellow "    cat /root/.ssh/id_ed25519.pub   # paste into github.com/settings/keys"
    c_yellow "  Then re-run this script."
    exit 4
  fi
  ok "cloned"
else
  (cd "${REPO_DIR}" && git pull --ff-only 2>&1 | tail -3)
  ok "pulled latest"
fi

# Re-locate ourselves in case the user copied the script outside the repo.
REPO_ROOT="${REPO_DIR}"

# ─── Step 5: hermes API key check ────────────────────────────────────────────
step "Step 5/11: Hermes API key"

# `hermes setup` is interactive (prompts for provider + API key). We can't
# automate that without leaking the key. Detect "no provider configured" and
# bail with instructions.
if ! [[ -f "${HERMES_HOME}/auth.json" ]] || ! grep -q '"credential_pool":\s*{[^}]' "${HERMES_HOME}/auth.json" 2>/dev/null; then
  warn "no provider credentials in ${HERMES_HOME}/auth.json"
  c_yellow ""
  c_yellow "  Run interactively to add an LLM provider:"
  c_yellow ""
  c_yellow "    hermes setup       # follow the prompts (paste API key)"
  c_yellow ""
  c_yellow "  Then re-run this script."
  exit 5
fi
ok "credential pool populated"

# ─── Step 6: gateway .env ────────────────────────────────────────────────────
step "Step 6/11: gateway .env"

ENV_FILE="${REPO_DIR}/backend/.env"
ENV_EXAMPLE="${REPO_DIR}/backend/.env.example"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ ! -f "${ENV_EXAMPLE}" ]]; then
    c_red "  neither ${ENV_FILE} nor ${ENV_EXAMPLE} exists"
    exit 6
  fi
  cp "${ENV_EXAMPLE}" "${ENV_FILE}"
  warn "created ${ENV_FILE} from .env.example — fill in real values now:"
  c_yellow "    nano ${ENV_FILE}"
  c_yellow ""
  c_yellow "  Required (see DEPLOYMENT.md §Secrets for details):"
  c_yellow "    JWT_SECRET, BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD,"
  c_yellow "    EXPO_ACCESS_TOKEN, APNS_KEY_ID, APNS_KEY_P8, APNS_TEAM_ID,"
  c_yellow "    APNS_BUNDLE_ID"
  c_yellow ""
  c_yellow "  Then re-run this script."
  exit 6
fi

# Detect obvious placeholders. If still present, bail.
if grep -qE '^(JWT_SECRET|BOOTSTRAP_PASSWORD|APNS_KEY_P8|EXPO_ACCESS_TOKEN)=(\s*$|change[-_]me|placeholder|TODO|XXX)' "${ENV_FILE}"; then
  warn "${ENV_FILE} still contains placeholder values"
  grep -nE '^(JWT_SECRET|BOOTSTRAP_PASSWORD|APNS_KEY_P8|EXPO_ACCESS_TOKEN)=(\s*$|change[-_]me|placeholder|TODO|XXX)' "${ENV_FILE}" || true
  c_yellow "  Edit and re-run."
  exit 6
fi
ok "${ENV_FILE} present, no obvious placeholders"

# ─── Step 7: build gateway ───────────────────────────────────────────────────
step "Step 7/11: gateway build + migrations"

(
  cd "${REPO_DIR}/backend"

  # Skip pnpm install if node_modules is in sync with the lock file.
  if [[ ! -d node_modules ]] || ! pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -3; then
    pnpm install --frozen-lockfile
  fi

  # Skip rebuild if dist/ is newer than src/. Fast no-op when already built.
  if [[ ! -d dist ]] || [[ "$(find src -newer dist/src/index.js -type f 2>/dev/null | head -1)" ]]; then
    pnpm build 2>&1 | tail -3
    ok "built"
  else
    ok "dist up to date"
  fi

  # Migrations are idempotent (Drizzle tracks applied versions).
  pnpm db:migrate 2>&1 | tail -3 || true
  ok "migrations applied"
)

# ─── Step 8: systemd units ───────────────────────────────────────────────────
step "Step 8/11: systemd units"

DASHBOARD_UNIT="/etc/systemd/system/hermes-dashboard.service"
GATEWAY_UNIT="/etc/systemd/system/hermes-gateway.service"
CRON_UNIT="/etc/systemd/system/hermes-cron.service"

read -r -d '' DESIRED_DASHBOARD <<EOF || true
[Unit]
Description=Hermes dashboard (provides /api/ws + tui_gateway for the mobile gateway)
After=network.target

[Service]
Type=simple
User=root
Environment=HOME=/root
Environment=HERMES_DASHBOARD_TUI=1
ExecStart=/usr/local/bin/hermes dashboard --port 9119 --host 127.0.0.1 --no-open --tui
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hermes-dashboard

[Install]
WantedBy=multi-user.target
EOF

read -r -d '' DESIRED_GATEWAY <<EOF || true
[Unit]
Description=Hermes mobile gateway (Fastify backend)
After=network.target hermes-dashboard.service
Wants=hermes-dashboard.service

[Service]
Type=simple
User=root
WorkingDirectory=${REPO_DIR}/backend
EnvironmentFile=${REPO_DIR}/backend/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hermes-gateway

[Install]
WantedBy=multi-user.target
EOF

# hermes-cron — Python `hermes gateway run` daemon. Only this process
# actually FIRES scheduled jobs. Without it, jobs sit at next_run forever.
# (This is the systemd equivalent of the local docker-compose hermes-cron
# sidecar that runs the same command.)
read -r -d '' DESIRED_CRON <<EOF || true
[Unit]
Description=Hermes cron + messaging gateway daemon (runs scheduled jobs)
After=network.target hermes-dashboard.service
Wants=hermes-dashboard.service

[Service]
Type=simple
User=root
Environment=HOME=/root
ExecStart=/usr/local/bin/hermes gateway run
Restart=on-failure
RestartSec=3
StandardOutput=journal
StandardError=journal
SyslogIdentifier=hermes-cron

[Install]
WantedBy=multi-user.target
EOF

write_unit_if_changed() {
  local path="$1" desired="$2"
  if [[ -f "$path" ]] && diff -q <(printf '%s\n' "$desired") "$path" >/dev/null 2>&1; then
    ok "$(basename "$path") up to date"
  else
    printf '%s\n' "$desired" > "$path"
    ok "wrote $(basename "$path")"
    SERVICES_DIRTY=1
  fi
}

write_unit_if_changed "${DASHBOARD_UNIT}" "${DESIRED_DASHBOARD}"
write_unit_if_changed "${GATEWAY_UNIT}"   "${DESIRED_GATEWAY}"
write_unit_if_changed "${CRON_UNIT}"      "${DESIRED_CRON}"

if [[ "${SERVICES_DIRTY}" -eq 1 ]]; then
  systemctl daemon-reload
fi
systemctl enable hermes-dashboard hermes-gateway hermes-cron >/dev/null 2>&1

# ─── Step 9: nginx + TLS ─────────────────────────────────────────────────────
step "Step 9/11: nginx + TLS for ${DOMAIN}"

NGINX_SITE="/etc/nginx/sites-available/hermes"
NGINX_LINK="/etc/nginx/sites-enabled/hermes"

# Pre-cert nginx config (port 80 only). Certbot will rewrite this with TLS.
read -r -d '' DESIRED_NGINX <<EOF || true
server {
  listen 80;
  server_name ${DOMAIN};

  client_max_body_size 25m;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;

    # WebSocket upgrade (chat WS lives at /ws).
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
  }
}
EOF

if [[ ! -f "${NGINX_SITE}" ]] || ! diff -q <(printf '%s\n' "${DESIRED_NGINX}") "${NGINX_SITE}" >/dev/null 2>&1; then
  # If certbot has already added TLS to the file, don't overwrite it. Check
  # for "ssl_certificate" — if present, certbot has mutated this file and we
  # must leave it alone.
  if grep -q 'ssl_certificate' "${NGINX_SITE}" 2>/dev/null; then
    ok "nginx site already has TLS — leaving alone"
  else
    printf '%s\n' "${DESIRED_NGINX}" > "${NGINX_SITE}"
    ln -sf "${NGINX_SITE}" "${NGINX_LINK}"
    rm -f /etc/nginx/sites-enabled/default
    nginx -t
    systemctl reload nginx
    ok "wrote and reloaded nginx (HTTP only)"
  fi
else
  ok "nginx site up to date"
fi

# Detect if certbot has installed a cert for the domain. If not, run it.
if [[ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
  warn "no Let's Encrypt cert for ${DOMAIN}"
  if [[ -n "${CERTBOT_EMAIL}" ]]; then
    certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos --email "${CERTBOT_EMAIL}" --redirect
    ok "certbot succeeded"
  else
    c_yellow ""
    c_yellow "  Run interactively to obtain + install the cert:"
    c_yellow ""
    c_yellow "    certbot --nginx -d ${DOMAIN}"
    c_yellow ""
    c_yellow "  Or pass CERTBOT_EMAIL=you@example.com to this script for automation."
    c_yellow "  Then re-run this script."
    exit 9
  fi
else
  ok "TLS cert already installed (auto-renew via certbot.timer)"
fi

# ─── Step 10: hermes config patches ──────────────────────────────────────────
step "Step 10/11: patch-hermes-config.py + patch-hermes-reload-mcp.py + skills"

python3 "${REPO_ROOT}/scripts/patch-hermes-config.py" --config "${HERMES_HOME}/config.yaml"
python3 "${REPO_ROOT}/scripts/patch-hermes-reload-mcp.py" || c_yellow "  reload-mcp source patch skipped (anchor may have moved — non-fatal)"
python3 "${REPO_ROOT}/scripts/patch-hermes-slash-history.py" || c_yellow "  slash-history source patch skipped (anchor may have moved — non-fatal)"
python3 "${REPO_ROOT}/scripts/patch-hermes-stt-rpc.py" || c_yellow "  stt-rpc source patch skipped (anchor may have moved — non-fatal)"

# Deploy custom skills to ~/.hermes/skills/. Currently: manage-mcp (teaches
# the agent to add/remove MCP servers end-to-end when the user asks).
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

# ─── Step 11: start + verify ─────────────────────────────────────────────────
step "Step 11/11: start services + verify"

# Always restart in correct order so a fresh _SESSION_TOKEN is picked up by
# the gateway. SERVICES_DIRTY captures unit changes; config patch may also
# require a restart, so do it unconditionally on first install.
systemctl restart hermes-dashboard
sleep 3
systemctl restart hermes-gateway hermes-cron
sleep 2
ok "services restarted"

if ! systemctl is-active --quiet hermes-dashboard hermes-gateway hermes-cron nginx; then
  c_red "  one or more services not active:"
  systemctl --no-pager --lines=5 status hermes-dashboard hermes-gateway hermes-cron nginx | head -40
  exit 11
fi
ok "all services active"

local_health="$(curl -sS -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8080/health || echo 000)"
[[ "${local_health}" == "200" ]] && ok "gateway /health = 200" || warn "gateway /health = ${local_health}"

public_health="$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "https://${DOMAIN}/health" || echo 000)"
[[ "${public_health}" == "200" ]] && ok "https://${DOMAIN}/health = 200" || warn "public health = ${public_health}"

# ─── Optional: Obsidian Sync ─────────────────────────────────────────────────
c_green ""
if [[ "${SKIP_OBSIDIAN}" == "1" ]]; then
  c_green "Skipping Obsidian (SKIP_OBSIDIAN=1)."
else
  step "Step 11.5: Obsidian Sync (chained)"
  c_yellow "  Running scripts/install-obsidian-sync.sh next."
  c_yellow "  It will bail at \`ob login\` (interactive — needs MFA). Run as instructed,"
  c_yellow "  then re-invoke just that script (this one is already done)."
  c_yellow ""
  bash "${REPO_ROOT}/scripts/install-obsidian-sync.sh" || true
fi

c_green ""
c_green "Done."
c_green ""
c_green "If anything is still off, check:"
c_green "  journalctl -u hermes-gateway --since '1 minute ago' --no-pager | tail -30"
c_green "  journalctl -u hermes-dashboard --since '1 minute ago' --no-pager | tail -30"
