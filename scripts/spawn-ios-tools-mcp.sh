#!/usr/bin/env bash
# spawn-ios-tools-mcp.sh — wrapper that Hermes invokes to spawn the
# ios-tools MCP stdio server. We need this wrapper because Hermes does
# NOT propagate parent process env vars to MCP child processes — it
# builds the child env from ONLY the `env:` block in mcp_servers config.
# Listing IOS_MCP_TOKEN / IOS_MCP_USER_ID in that block as ${VAR}
# placeholders also doesn't work (Hermes doesn't do shell substitution),
# and listing them as static values would expose secrets in config.yaml
# (which is committed in snapshots and may be reviewed).
#
# This wrapper sources the env file at spawn time and execs into the
# Node MCP server. Result: secrets stay in /root/.hermes/.env (already
# protected, already in snapshot), and rotation is just edit the .env
# file — no re-run of patch-hermes-config.py.
#
# Required env (loaded from $HERMES_HOME/.env or /root/.hermes/.env):
#   GATEWAY_URL=http://127.0.0.1:8080
#   IOS_MCP_TOKEN=<32-byte hex, must match backend/.env>
#   IOS_MCP_USER_ID=<gateway DB user.id>
#
# Used in mcp_servers.ios-tools.command in /root/.hermes/config.yaml.

set -e

ENV_FILE="${HERMES_HOME:-/root/.hermes}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

# Default GATEWAY_URL if not set (covers fresh installs where .env may
# not yet have it).
: "${GATEWAY_URL:=http://127.0.0.1:8080}"
export GATEWAY_URL

# Resolve the script path. Default assumes the standard VPS layout;
# override via $IOS_TOOLS_STDIO_JS for local-docker or other paths.
STDIO_JS="${IOS_TOOLS_STDIO_JS:-/root/repos/Hermes_agent/backend/dist/src/mcp/ios-tools-stdio.js}"

if [[ ! -f "${STDIO_JS}" ]]; then
  echo "[spawn-ios-tools-mcp] FATAL: ${STDIO_JS} not found. Did you run \`pnpm build\` in backend?" >&2
  exit 1
fi

exec node "${STDIO_JS}"
