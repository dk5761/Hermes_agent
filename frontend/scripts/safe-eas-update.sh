#!/usr/bin/env bash
#
# safe-eas-update.sh — wrapper around `eas update` that refuses to publish
# when the resolved EXPO_PUBLIC_API_URL or EXPO_PUBLIC_WS_URL points at a
# local/private IP.
#
# Why this exists: `eas update` reads the JS bundle's env from
# process.env + the local `.env` file at bundle time. The `build.<profile>.env`
# block in `eas.json` only applies to `eas build`, NOT `eas update`. A dev
# running raw `eas update --channel production` from their workstation will
# bake their local LAN URL into the production OTA.
#
# We protect against that two ways:
#   1. EAS server-side env vars (set via `eas env:create`) — always pulled
#      automatically by `eas update --channel <name>`. This is the structural
#      fix; this script is the safety net for cases where someone overrides
#      EXPO_PUBLIC_API_URL in their shell or .env.
#   2. This script — checks the resolved URL one last time before invoking
#      `eas update`. If it looks local, exit non-zero with an explanation.
#
# Usage:
#   ./scripts/safe-eas-update.sh --channel production -m "<message>"
#   pnpm update:prod -m "<message>"   # if package.json wires it up
#
# Bypass (rare; for dev-channel updates pointing at LAN intentionally):
#   ALLOW_LOCAL_URL=1 ./scripts/safe-eas-update.sh --channel development ...
set -euo pipefail

API_URL="${EXPO_PUBLIC_API_URL:-}"
WS_URL="${EXPO_PUBLIC_WS_URL:-}"

# If unset locally, eas update will pull from EAS env vars on the server,
# which is the desired path. Empty here is a non-issue.
if [[ -z "$API_URL" && -z "$WS_URL" ]]; then
  exec eas update "$@"
fi

# Pattern matches localhost, IPv4 loopback, and RFC1918 private ranges.
LOCAL_RE='(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)'

flag_local() {
  local name="$1" value="$2"
  if [[ -n "$value" && "$value" =~ $LOCAL_RE ]]; then
    return 0
  fi
  return 1
}

bad=0
if flag_local "EXPO_PUBLIC_API_URL" "$API_URL"; then
  echo "✗ EXPO_PUBLIC_API_URL points at a local address: $API_URL" >&2
  bad=1
fi
if flag_local "EXPO_PUBLIC_WS_URL" "$WS_URL"; then
  echo "✗ EXPO_PUBLIC_WS_URL points at a local address: $WS_URL" >&2
  bad=1
fi

if [[ "$bad" == "1" ]]; then
  if [[ "${ALLOW_LOCAL_URL:-}" == "1" ]]; then
    echo "  ALLOW_LOCAL_URL=1 set — proceeding anyway." >&2
  else
    cat >&2 <<EOF

  Refusing to publish. The resolved env in your shell points at a
  local/private network address — running 'eas update' now would bake
  that URL into the OTA bundle that ships to real users.

  Fixes:
    - Unset the override in your shell (\`unset EXPO_PUBLIC_API_URL\`)
      or remove it from frontend/.env, then re-run.
    - EAS server-side env vars (\`eas env:list --environment production\`)
      will be picked up automatically when nothing's set locally.

  If you really mean to ship a LAN URL (rare; e.g. internal dev channel),
  re-run with ALLOW_LOCAL_URL=1.

EOF
    exit 1
  fi
fi

exec eas update "$@"
