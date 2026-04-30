#!/usr/bin/env bash
# Fetch the per-process Hermes session token from the running dashboard
# and (optionally) write it into backend/.env as HERMES_TOKEN.
#
# Usage:
#   ./scripts/hermes-token.sh             # print token to stdout
#   ./scripts/hermes-token.sh --write     # also patch backend/.env
set -euo pipefail

URL="${HERMES_URL:-http://127.0.0.1:9119/}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/../backend/.env}"

html=$(curl -sf "$URL" || { echo "error: cannot reach $URL — is hermes container up?" >&2; exit 1; })
token=$(printf '%s' "$html" | grep -oE 'window\.__HERMES_SESSION_TOKEN__\s*=\s*"[^"]+"' | sed -E 's/.*"([^"]+)".*/\1/' | head -n1)

if [ -z "$token" ]; then
  echo "error: token not found in served HTML" >&2
  exit 2
fi

if [ "${1:-}" = "--write" ]; then
  if [ ! -f "$ENV_FILE" ]; then
    echo "error: $ENV_FILE not found — copy backend/.env.example first" >&2
    exit 3
  fi
  if grep -q '^HERMES_TOKEN=' "$ENV_FILE"; then
    sed -i.bak -E "s|^HERMES_TOKEN=.*|HERMES_TOKEN=$token|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '\nHERMES_TOKEN=%s\n' "$token" >> "$ENV_FILE"
  fi
  echo "wrote HERMES_TOKEN to $ENV_FILE"
fi

echo "$token"
