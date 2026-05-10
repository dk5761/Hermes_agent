#!/usr/bin/env bash
#
# setup-r2-backup.sh — one-time helper that wires the VPS for Cloudflare R2
# backups. Installs rclone (if missing), writes /root/.config/rclone/rclone.conf
# with the R2 remote, and verifies bucket access with a list call.
#
# Idempotent: re-running with the same env values is a no-op.
#
# Required env (or interactive prompt if unset):
#   CF_R2_ACCOUNT_ID         — Cloudflare account id (32 hex chars)
#   CF_R2_ACCESS_KEY_ID      — R2 API token access key
#   CF_R2_SECRET_ACCESS_KEY  — R2 API token secret
#   CF_R2_BUCKET             — bucket name (e.g. hermes-snapshots)
#
# Optional env:
#   RCLONE_REMOTE_NAME       — defaults to "hermesr2"
#   RCLONE_CONFIG            — path override (defaults to /root/.config/rclone/rclone.conf)
#
# Usage:
#   sudo CF_R2_ACCOUNT_ID=… CF_R2_ACCESS_KEY_ID=… CF_R2_SECRET_ACCESS_KEY=… \
#        CF_R2_BUCKET=hermes-snapshots \
#        bash /root/repos/Hermes_agent/scripts/setup-r2-backup.sh
#
#   # Or interactively (script prompts for missing values):
#   sudo bash /root/repos/Hermes_agent/scripts/setup-r2-backup.sh
#
# How to get the credentials:
#   1. Cloudflare dashboard → R2 → Create bucket (any region; Auto recommended).
#   2. R2 → Manage R2 API Tokens → Create API token.
#      - Permission: Object Read & Write
#      - Specify bucket: <your bucket>
#      - TTL: never (or rotate via this script)
#   3. Copy the Access Key ID + Secret Access Key from the success screen.
#   4. Account ID is on the R2 overview page (top right).
set -euo pipefail

REMOTE="${RCLONE_REMOTE_NAME:-hermesr2}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/root/.config/rclone/rclone.conf}"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()     { printf '\033[34m==> %s\033[0m\n' "$*"; }
ok()       { c_green "  ✓ $*"; }

if [[ "${EUID}" -ne 0 ]]; then
  c_red "must run as root (or via sudo)"
  exit 1
fi

# ─── Step 1: prompt for any missing creds ──────────────────────────────────
prompt_secret() {
  local var="$1" label="$2"
  if [[ -z "${!var:-}" ]]; then
    read -r -s -p "${label}: " val
    echo
    eval "${var}=\${val}"
  fi
}

prompt_value() {
  local var="$1" label="$2"
  if [[ -z "${!var:-}" ]]; then
    read -r -p "${label}: " val
    eval "${var}=\${val}"
  fi
}

step "Step 1/4: collect credentials"
prompt_value  CF_R2_ACCOUNT_ID         "Cloudflare account id"
prompt_value  CF_R2_ACCESS_KEY_ID      "R2 access key id"
prompt_secret CF_R2_SECRET_ACCESS_KEY  "R2 secret access key"
prompt_value  CF_R2_BUCKET             "R2 bucket name"

# Sanity checks. Account id is 32 hex chars; access keys vary; bucket is
# loosely validated (rclone will fail on lookup if misspelled).
if [[ ! "${CF_R2_ACCOUNT_ID}" =~ ^[0-9a-fA-F]{32}$ ]]; then
  c_yellow "  account id doesn't look like 32 hex chars (got '${CF_R2_ACCOUNT_ID:0:8}…') — continuing anyway"
fi
ok "credentials collected"

# ─── Step 2: install rclone if missing ─────────────────────────────────────
step "Step 2/4: rclone install"
if command -v rclone >/dev/null 2>&1; then
  ok "rclone already installed ($(rclone version 2>/dev/null | head -1))"
else
  c_yellow "  installing rclone via official script"
  curl -fsSL https://rclone.org/install.sh | bash
  ok "rclone installed ($(rclone version 2>/dev/null | head -1))"
fi

# ─── Step 3: write rclone config ───────────────────────────────────────────
step "Step 3/4: rclone remote '${REMOTE}'"
mkdir -p "$(dirname "${RCLONE_CONFIG}")"
chmod 700 "$(dirname "${RCLONE_CONFIG}")"

# rclone uses the S3 backend with provider=Cloudflare. Endpoint is the
# account-scoped R2 URL. region/location_constraint are ignored by R2 but
# are required by some rclone S3 paths; "auto" is the documented value.
TMP_CFG="$(mktemp)"
trap 'rm -f "${TMP_CFG}"' EXIT

# If the file exists, copy it then replace just our remote. Otherwise start fresh.
if [[ -f "${RCLONE_CONFIG}" ]]; then
  cp "${RCLONE_CONFIG}" "${TMP_CFG}"
  # Strip an existing [REMOTE] block (everything from `[REMOTE]` up to the
  # next `[...]` header or EOF). Idempotent rewrite.
  awk -v r="[${REMOTE}]" '
    BEGIN { skip = 0 }
    /^\[/ { skip = ($0 == r) }
    !skip { print }
  ' "${TMP_CFG}" > "${TMP_CFG}.stripped"
  mv "${TMP_CFG}.stripped" "${TMP_CFG}"
fi

# Append the desired block.
cat >> "${TMP_CFG}" <<EOF
[${REMOTE}]
type = s3
provider = Cloudflare
access_key_id = ${CF_R2_ACCESS_KEY_ID}
secret_access_key = ${CF_R2_SECRET_ACCESS_KEY}
endpoint = https://${CF_R2_ACCOUNT_ID}.r2.cloudflarestorage.com
acl = private
no_check_bucket = true
EOF

mv "${TMP_CFG}" "${RCLONE_CONFIG}"
chmod 600 "${RCLONE_CONFIG}"
ok "wrote ${RCLONE_CONFIG}"

# Persist bucket name in a sibling file so the snapshot/restore scripts
# don't need it passed every run. Same file is read by hermes-snapshot.sh.
echo "${CF_R2_BUCKET}" > /root/.r2-bucket
chmod 600 /root/.r2-bucket
ok "stored bucket name in /root/.r2-bucket"

# ─── Step 4: verify access ─────────────────────────────────────────────────
step "Step 4/4: smoke test"
if rclone lsd "${REMOTE}:${CF_R2_BUCKET}" >/dev/null 2>&1; then
  count="$(rclone ls "${REMOTE}:${CF_R2_BUCKET}" 2>/dev/null | wc -l | tr -d ' ')"
  ok "${REMOTE}:${CF_R2_BUCKET} reachable (${count} objects)"
else
  c_red "  rclone failed to access ${REMOTE}:${CF_R2_BUCKET}"
  c_yellow "  Verify: bucket name spelling + token permissions (Object Read & Write)"
  exit 5
fi

c_green ""
c_green "R2 backup configured. Next:"
c_green "  - hermes-snapshot.sh now pushes encrypted snapshots to ${REMOTE}:${CF_R2_BUCKET}"
c_green "  - restore-from-snapshot.sh pulls from the same bucket"
c_green "  - rotate the API token by re-running this script with new credentials"
