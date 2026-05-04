#!/usr/bin/env bash
# restore-from-snapshot.sh — restore VPS state from the latest encrypted
# snapshot in the hermes-snapshots GitHub repo. Counterpart to
# scripts/hermes-snapshot.sh.
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
# Pre-reqs:
#   - hermes-snapshots repo cloned at /root/hermes-snapshots
#     (auto-clones if REPO_URL provided; otherwise fails with instructions)
#   - /root/.hermes-snapshot.pass with the GPG passphrase
#   - GPG installed (apt install gnupg2)
#
# Usage:
#   sudo bash /root/repos/Hermes_agent/scripts/restore-from-snapshot.sh
#   sudo SNAPSHOT=snapshot-2026-05-04T04-00-04Z.tar.gz.gpg bash ...
#   sudo REPO_URL=git@github.com:dk5761/hermes-snapshots.git bash ...

set -euo pipefail

REPO_DIR="${REPO_DIR:-/root/hermes-snapshots}"
REPO_URL="${REPO_URL:-}"
PASSFILE="${PASSFILE:-/root/.hermes-snapshot.pass}"
SNAPSHOT="${SNAPSHOT:-}"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
step()     { c_blue "==> $*"; }
ok()       { c_green "  ✓ $*"; }

if [[ "${EUID}" -ne 0 ]]; then c_red "must run as root (or via sudo)"; exit 1; fi

# ─── Step 1: passfile ────────────────────────────────────────────────────────
step "Step 1/5: GPG passphrase file"

if [[ ! -f "${PASSFILE}" ]]; then
  c_red "  ${PASSFILE} not found"
  c_yellow "  Restore the passphrase first:"
  c_yellow "    echo 'YOUR-PASSPHRASE' > ${PASSFILE} && chmod 600 ${PASSFILE}"
  c_yellow "  (Same passphrase you used when initially setting up hermes-snapshot.sh.)"
  exit 1
fi
ok "passfile present"

# ─── Step 2: snapshots repo ──────────────────────────────────────────────────
step "Step 2/5: snapshots repo at ${REPO_DIR}"

if [[ ! -d "${REPO_DIR}/.git" ]]; then
  if [[ -z "${REPO_URL}" ]]; then
    c_red "  ${REPO_DIR} doesn't exist and REPO_URL not set"
    c_yellow "  Clone manually OR re-run with REPO_URL=git@github.com:user/hermes-snapshots.git"
    exit 2
  fi
  mkdir -p "$(dirname "${REPO_DIR}")"
  git clone "${REPO_URL}" "${REPO_DIR}"
  ok "cloned"
else
  (cd "${REPO_DIR}" && git pull --ff-only 2>&1 | tail -2)
  ok "pulled latest"
fi

# ─── Step 3: pick a snapshot ─────────────────────────────────────────────────
step "Step 3/5: select snapshot"

cd "${REPO_DIR}"

if [[ -n "${SNAPSHOT}" ]]; then
  if [[ ! -f "${SNAPSHOT}" ]]; then
    c_red "  explicit SNAPSHOT='${SNAPSHOT}' not found"
    c_yellow "  Available:"
    ls -lt snapshot-*.tar.gz.gpg 2>/dev/null | head -10
    exit 3
  fi
  TARGET="${SNAPSHOT}"
else
  TARGET="$(ls -t snapshot-*.tar.gz.gpg 2>/dev/null | head -1)"
  if [[ -z "${TARGET}" ]]; then
    c_red "  no snapshots found in ${REPO_DIR}"
    exit 3
  fi
fi
SIZE="$(du -h "${TARGET}" | cut -f1)"
ok "using ${TARGET} (${SIZE})"

# ─── Step 4: decrypt + extract ───────────────────────────────────────────────
step "Step 4/5: decrypt + extract to /"

# Test decrypt to a temp file first so we don't half-extract on bad passphrase.
TMP_TAR="$(mktemp /tmp/hermes-restore.XXXXXX.tar.gz)"
trap 'rm -f "${TMP_TAR}"' EXIT

if ! gpg --batch --quiet --decrypt --passphrase-file "${PASSFILE}" \
      --output "${TMP_TAR}" "${TARGET}"; then
  c_red "  decryption failed — wrong passphrase?"
  exit 4
fi
ok "decrypted ($(du -h "${TMP_TAR}" | cut -f1))"

# Sanity-check the tarball includes the key paths before extracting.
EXPECTED_PATHS=("root/.hermes/")
for path in "${EXPECTED_PATHS[@]}"; do
  if ! tar tzf "${TMP_TAR}" 2>/dev/null | grep -q "^${path}"; then
    c_red "  snapshot is missing expected path: ${path}"
    exit 4
  fi
done
ok "snapshot structure verified"

# Extract. tar overwrites existing files but doesn't delete unrelated content
# in the target directories — so a partially-set-up VPS is brought UP to the
# snapshot's state, never blanked.
tar xzf "${TMP_TAR}" -C /
ok "extracted"

# ─── Step 5: verify + next steps ─────────────────────────────────────────────
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
