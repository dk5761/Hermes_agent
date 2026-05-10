#!/usr/bin/env bash
# hermes-snapshot.sh — encrypted snapshot of Hermes state + gateway secrets
# + obsidian auth, pushed to a Cloudflare R2 bucket via rclone.
#
# Counterpart to scripts/restore-from-snapshot.sh. One-time setup is in
# scripts/setup-r2-backup.sh (configures the rclone remote + writes
# /root/.r2-bucket).
#
# This is the canonical version. The live copy at /root/hermes-snapshot.sh
# may be out of date — re-deploy with:
#   sudo cp scripts/hermes-snapshot.sh /root/hermes-snapshot.sh
#
# What's backed up:
#   - /root/.hermes/                          memories, cron jobs, sessions, skills, auth.json, config.yaml
#   - /root/.config/obsidian-headless/        ob login token (skips manual MFA on restore)
#   - /root/repos/Hermes_agent/backend/.env   gateway secrets (JWT, APNS, BOOTSTRAP, EXPO)
#   - /root/repos/Hermes_agent/backend/data/  gateway DB + uploaded blobs
#
# What's NOT backed up (intentional):
#   - /opt/obsidian-vault/   — refills from Obsidian Sync after `ob sync`
#   - /etc/letsencrypt/      — certbot will re-issue, brief HTTPS gap on rebuild
#   - /etc/nginx/            — re-rendered by install-vps.sh
#   - /etc/systemd/system/hermes-*.service — re-rendered by install-vps.sh
#
# Run via cron daily:
#   0 4 * * * /root/hermes-snapshot.sh >> /var/log/hermes-snapshot.log 2>&1

set -euo pipefail

LOCAL_DIR="${LOCAL_DIR:-/root/hermes-snapshots}"
PASSFILE="${PASSFILE:-/root/.hermes-snapshot.pass}"
RCLONE_REMOTE="${RCLONE_REMOTE:-hermesr2}"
KEEP_DAYS="${KEEP_DAYS:-14}"

# Bucket name written by setup-r2-backup.sh.
if [[ ! -f /root/.r2-bucket ]]; then
  echo "✗ /root/.r2-bucket not found — run scripts/setup-r2-backup.sh first" >&2
  exit 2
fi
BUCKET="$(cat /root/.r2-bucket)"
if [[ -z "${BUCKET}" ]]; then
  echo "✗ /root/.r2-bucket is empty" >&2
  exit 2
fi

if [[ ! -f "${PASSFILE}" ]]; then
  echo "✗ ${PASSFILE} not found — set the GPG passphrase first:" >&2
  echo "    echo 'YOUR-PASSPHRASE' > ${PASSFILE} && chmod 600 ${PASSFILE}" >&2
  exit 2
fi

mkdir -p "${LOCAL_DIR}"
cd "${LOCAL_DIR}"

DATE=$(date -u +%Y-%m-%dT%H-%M-%SZ)
SNAP="snapshot-${DATE}.tar.gz.gpg"

# Build encrypted tarball. --ignore-failed-read so a missing path
# (e.g. backend/.env on a partial install) doesn't kill the snapshot;
# the restore script verifies key files exist before extracting.
tar czf - \
  --ignore-failed-read \
  --exclude='audio_cache' \
  --exclude='image_cache' \
  --exclude='logs' \
  --exclude='models_dev_cache.json' \
  -C / \
    root/.hermes \
    root/.config/obsidian-headless \
    root/repos/Hermes_agent/backend/.env \
    root/repos/Hermes_agent/backend/data \
| gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-file "${PASSFILE}" \
      -o "${SNAP}"

SIZE_HUMAN="$(du -h "${SNAP}" | cut -f1)"
echo "[$(date -u +%FT%TZ)] built ${SNAP} (${SIZE_HUMAN})"

# Local retention — drop snapshots older than KEEP_DAYS so the VPS disk
# doesn't keep growing. We still ship every snapshot to R2.
find . -maxdepth 1 -name 'snapshot-*.tar.gz.gpg' -mtime +"${KEEP_DAYS}" -delete

# Push to R2. `rclone copy` is idempotent — same source twice is a no-op.
rclone copy "${SNAP}" "${RCLONE_REMOTE}:${BUCKET}/" \
  --quiet \
  --s3-no-check-bucket
echo "[$(date -u +%FT%TZ)] pushed to ${RCLONE_REMOTE}:${BUCKET}/${SNAP}"

# R2-side retention — purge snapshots older than KEEP_DAYS in the bucket.
# Matches the local retention so the bucket footprint stays bounded.
# Free tier is 10 GB; ~350 MB/snapshot × 14 days = ~4.9 GB, well under.
rclone delete "${RCLONE_REMOTE}:${BUCKET}/" \
  --include 'snapshot-*.tar.gz.gpg' \
  --min-age "${KEEP_DAYS}d" \
  --quiet \
  --s3-no-check-bucket || true
echo "[$(date -u +%FT%TZ)] purged R2 snapshots older than ${KEEP_DAYS}d"
