#!/usr/bin/env bash
set -euo pipefail
SRC="${1:-./data/blobs}"
OUT="${2:-./backups/blobs}"
mkdir -p "$OUT"
rsync -a --delete "$SRC/" "$OUT/"
echo "synced $SRC -> $OUT"
