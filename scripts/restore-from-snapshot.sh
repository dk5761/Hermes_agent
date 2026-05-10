#!/usr/bin/env bash
# restore-from-snapshot.sh — restore VPS state from an encrypted snapshot
# stored in Cloudflare R2. Counterpart to scripts/hermes-snapshot.sh.
# One-time setup (rclone + bucket) is in scripts/setup-r2-backup.sh.
#
# What gets restored (extracted to /):
#   - /root/.hermes/                          all Hermes state
#   - /root/.config/obsidian-headless/        ob login token (skip ob login)
#   - /root/repos/Hermes_agent/backend/.env   gateway secrets
#   - /root/repos/Hermes_agent/backend/data/  gateway DB + blobs
#
# What still needs manual setup after restore:
#   - certbot --nginx -d <domain>             one TLS issuance, then auto-renews
#   - install-obsidian-sync.sh                pulls vault from Obsidian Sync cloud
#                                             (skips ob login if token restored)
#
# Pre-reqs (set up via scripts/setup-r2-backup.sh):
#   - /root/.hermes-snapshot.pass with the GPG passphrase
#   - /root/.r2-bucket with the bucket name
#   - rclone configured with remote 'hermesr2' (or override via RCLONE_REMOTE)
#   - GPG installed (apt install gnupg2)
#
# Usage:
#   sudo bash /root/repos/Hermes_agent/scripts/restore-from-snapshot.sh
#   sudo bash …/restore-from-snapshot.sh --list                    # show available
#   sudo SNAPSHOT=snapshot-2026-05-04T04-00-04Z.tar.gz.gpg bash …  # specific snapshot

set -euo pipefail

LOCAL_DIR="${LOCAL_DIR:-/root/hermes-snapshots}"
PASSFILE="${PASSFILE:-/root/.hermes-snapshot.pass}"
RCLONE_REMOTE="${RCLONE_REMOTE:-hermesr2}"
SNAPSHOT="${SNAPSHOT:-}"
LIST_ONLY=0

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
step()     { c_blue "==> $*"; }
ok()       { c_green "  ✓ $*"; }

# Args.
for arg in "$@"; do
  case "$arg" in
    --list) LIST_ONLY=1 ;;
    --snapshot=*) SNAPSHOT="${arg#--snapshot=}" ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      c_red "unknown arg: $arg"
      exit 1
      ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then c_red "must run as root (or via sudo)"; exit 1; fi

# ─── Pre-reqs ──────────────────────────────────────────────────────────────
if [[ ! -f /root/.r2-bucket ]]; then
  c_red "/root/.r2-bucket not found"
  c_yellow "Run scripts/setup-r2-backup.sh first to configure R2 access."
  exit 2
fi
BUCKET="$(cat /root/.r2-bucket)"
if [[ -z "${BUCKET}" ]]; then
  c_red "/root/.r2-bucket is empty"
  exit 2
fi

if ! command -v rclone >/dev/null 2>&1; then
  c_red "rclone not installed — run scripts/setup-r2-backup.sh first"
  exit 2
fi

# ─── Step 1: list ──────────────────────────────────────────────────────────
step "Step 1/5: list snapshots in ${RCLONE_REMOTE}:${BUCKET}"
LIST="$(rclone ls "${RCLONE_REMOTE}:${BUCKET}/" --include 'snapshot-*.tar.gz.gpg' --s3-no-check-bucket 2>&1 || true)"
if [[ -z "${LIST}" ]]; then
  c_red "no snapshots found in ${RCLONE_REMOTE}:${BUCKET}"
  exit 3
fi
# rclone ls format: "<size> <path>" — sort by path desc (date in name → newest first).
echo "${LIST}" | sort -r -k2 | head -10 | awk '{
  size_h = $1
  if (size_h+0 > 1024*1024) size_h = sprintf("%.1fM", $1/1024/1024)
  else if (size_h+0 > 1024) size_h = sprintf("%.1fK", $1/1024)
  print "  " $2 "  (" size_h ")"
}'

if [[ "${LIST_ONLY}" -eq 1 ]]; then
  exit 0
fi

# ─── Step 2: pick snapshot ─────────────────────────────────────────────────
step "Step 2/5: select snapshot"
if [[ -n "${SNAPSHOT}" ]]; then
  if ! echo "${LIST}" | grep -q " ${SNAPSHOT}$"; then
    c_red "  explicit SNAPSHOT='${SNAPSHOT}' not found in bucket"
    c_yellow "  See --list for available."
    exit 3
  fi
  TARGET="${SNAPSHOT}"
else
  TARGET="$(echo "${LIST}" | sort -r -k2 | head -1 | awk '{print $2}')"
fi
ok "using ${TARGET}"

# ─── Step 3: passfile ──────────────────────────────────────────────────────
step "Step 3/5: GPG passphrase file"
if [[ ! -f "${PASSFILE}" ]]; then
  c_red "  ${PASSFILE} not found"
  c_yellow "  Restore the passphrase first:"
  c_yellow "    echo 'YOUR-PASSPHRASE' > ${PASSFILE} && chmod 600 ${PASSFILE}"
  c_yellow "  (Same passphrase used when initially setting up hermes-snapshot.sh.)"
  exit 4
fi
ok "passfile present"

# ─── Step 4: download + decrypt + extract ──────────────────────────────────
step "Step 4/5: download + decrypt + extract"
mkdir -p "${LOCAL_DIR}"
LOCAL_SNAP="${LOCAL_DIR}/${TARGET}"

if [[ -f "${LOCAL_SNAP}" ]]; then
  ok "snapshot already cached locally — skipping download"
else
  rclone copy "${RCLONE_REMOTE}:${BUCKET}/${TARGET}" "${LOCAL_DIR}/" --s3-no-check-bucket
  ok "downloaded $(du -h "${LOCAL_SNAP}" | cut -f1)"
fi

# Decrypt to a temp file first so a bad passphrase doesn't half-extract.
TMP_TAR="$(mktemp /tmp/hermes-restore.XXXXXX.tar.gz)"
trap 'rm -f "${TMP_TAR}"' EXIT
if ! gpg --batch --quiet --decrypt --passphrase-file "${PASSFILE}" \
      --output "${TMP_TAR}" "${LOCAL_SNAP}"; then
  c_red "  decryption failed — wrong passphrase?"
  exit 5
fi
ok "decrypted ($(du -h "${TMP_TAR}" | cut -f1))"

# Sanity-check the tarball includes the key paths before extracting.
EXPECTED_PATHS=("root/.hermes/")
for path in "${EXPECTED_PATHS[@]}"; do
  if ! tar tzf "${TMP_TAR}" 2>/dev/null | grep -q "^${path}"; then
    c_red "  snapshot is missing expected path: ${path}"
    exit 5
  fi
done
ok "snapshot structure verified"

# Extract. tar overwrites existing files but doesn't delete unrelated content
# in the target directories — so a partially-set-up VPS is brought UP to the
# snapshot's state, never blanked.
tar xzf "${TMP_TAR}" -C /
ok "extracted"

# ─── Step 5: verify + next steps ───────────────────────────────────────────
step "Step 5/5: verify"
OK=1
check() {
  if [[ -e "$1" ]]; then
    ok "$2"
  else
    c_yellow "  ⚠ missing: $1 ($2)"
    OK=0
  fi
}

check /root/.hermes/memories/MEMORY.md           "Hermes memory"
check /root/.hermes/cron/jobs.json               "cron jobs"
check /root/.hermes/auth.json                    "auth credential pool"
check /root/.config/obsidian-headless/auth_token "obsidian-headless login token"
check /root/repos/Hermes_agent/backend/.env      "gateway secrets"
check /root/repos/Hermes_agent/backend/data/gateway.db "gateway DB"

c_green ""
if [[ "${OK}" -eq 1 ]]; then
  c_green "Restore complete. Next:"
else
  c_yellow "Restore partial — see warnings above. Next:"
fi
c_green ""
c_green "  1. Restart services so they pick up restored state:"
c_green "       systemctl restart hermes-dashboard hermes-gateway hermes-cron"
c_green ""
c_green "  2. Bring the Obsidian vault back from cloud:"
c_green "       sudo bash /root/repos/Hermes_agent/scripts/install-obsidian-sync.sh"
c_green "       (skips ob login if the auth token was restored)"
c_green ""
c_green "  3. Verify the gateway sees Hermes:"
c_green "       curl -s http://127.0.0.1:8080/health"
c_green "       curl -s https://<your-domain>/health"
