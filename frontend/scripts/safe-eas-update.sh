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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# Read a variable's value from a .env-style file. Strips surrounding quotes
# and ignores commented lines. Returns empty if the file is missing or the
# variable isn't defined.
read_env_var() {
  local file="$1" name="$2"
  [[ -f "$file" ]] || return 0
  awk -v n="$name" '
    /^[[:space:]]*#/ { next }
    {
      sub(/^[[:space:]]*export[[:space:]]+/, "")
      eq = index($0, "=")
      if (eq == 0) next
      key = substr($0, 1, eq - 1)
      gsub(/[[:space:]]+$/, "", key)
      if (key != n) next
      val = substr($0, eq + 1)
      gsub(/[[:space:]]+$/, "", val)
      gsub(/^"|"$/, "", val)
      gsub(/^'\''|'\''$/, "", val)
      print val
      exit
    }
  ' "$file"
}

# Resolve effective values. Shell process.env wins over .env (matches metro
# behavior), but we check BOTH because metro reads .env at bundle time and
# we want to fail fast if either source has a local URL.
SHELL_API="${EXPO_PUBLIC_API_URL:-}"
SHELL_WS="${EXPO_PUBLIC_WS_URL:-}"
ENV_API="$(read_env_var "$ENV_FILE" EXPO_PUBLIC_API_URL)"
ENV_WS="$(read_env_var "$ENV_FILE" EXPO_PUBLIC_WS_URL)"

API_URL="${SHELL_API:-$ENV_API}"
WS_URL="${SHELL_WS:-$ENV_WS}"

# If both sources are empty, eas update will fall back entirely to EAS
# server-side env vars (the desired path). Proceed.
if [[ -z "$API_URL" && -z "$WS_URL" ]]; then
  exec eas update "$@"
fi

# Pattern matches localhost, IPv4 loopback, and RFC1918 private ranges.
LOCAL_RE='(localhost|127\.|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)'

flag_local() {
  local value="$1"
  [[ -n "$value" && "$value" =~ $LOCAL_RE ]]
}

bad=0
report() {
  local name="$1" shell_v="$2" env_v="$3"
  if flag_local "$shell_v"; then
    echo "✗ $name (shell) points at a local address: $shell_v" >&2
    bad=1
  fi
  if flag_local "$env_v"; then
    echo "✗ $name (.env) points at a local address: $env_v" >&2
    bad=1
  fi
}
report "EXPO_PUBLIC_API_URL" "$SHELL_API" "$ENV_API"
report "EXPO_PUBLIC_WS_URL" "$SHELL_WS" "$ENV_WS"

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
