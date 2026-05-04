#!/usr/bin/env bash
# hermes-snapshot.sh — encrypted daily backup of Hermes state +
# gateway secrets + obsidian auth, pushed to the private hermes-snapshots
# GitHub repo. Restored via scripts/restore-from-snapshot.sh.
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

REPO=/root/hermes-snapshots
PASSFILE=/root/.hermes-snapshot.pass
KEEP_DAYS=14

cd "$REPO"
git pull --rebase --quiet || true

DATE=$(date -u +%Y-%m-%dT%H-%M-%SZ)
SNAP="snapshot-$DATE.tar.gz.gpg"

# --ignore-failed-read so a missing path (e.g. backend/.env on a partial install)
# doesn't kill the snapshot. The restore script verifies key files exist.
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
      --passphrase-file "$PASSFILE" \
      -o "$SNAP"

find . -maxdepth 1 -name 'snapshot-*.tar.gz.gpg' -mtime +$KEEP_DAYS -delete

git add -A
if ! git diff --cached --quiet; then
  git commit -m "snapshot $DATE ($(du -h "$SNAP" | cut -f1))"
  git push --quiet
fi

# Weekly maintenance — gc + force-push to keep repo size sane.
if [ "$(date -u +%u)" = "7" ]; then
  git gc --prune=now --aggressive --quiet
  git push --force-with-lease --quiet || true
fi
