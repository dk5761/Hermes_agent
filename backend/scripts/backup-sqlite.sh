#!/usr/bin/env bash
set -euo pipefail
DB="${1:-./data/gateway.db}"
OUT="${2:-./backups}"
mkdir -p "$OUT"
TS=$(date +%Y%m%d-%H%M%S)
sqlite3 "$DB" ".backup '$OUT/gateway-$TS.db'"
gzip -9 "$OUT/gateway-$TS.db"
echo "wrote $OUT/gateway-$TS.db.gz"
