#!/usr/bin/env bash
# spawn-cron-scheduler-mcp.sh — wrapper that Hermes invokes to spawn the
# cron-scheduler MCP stdio server.
#
# Mirrors spawn-ios-tools-mcp.sh. Same rationale:
#   - Hermes does NOT propagate parent process env to MCP child processes.
#   - The `env:` block in mcp_servers config doesn't do shell-style ${VAR}
#     substitution.
#   - Listing static values in config.yaml would commit secrets into snapshots.
#
# We source $HERMES_HOME/.env at spawn time and exec into the Node MCP server.
# Secrets stay in /root/.hermes/.env; rotation is just an .env edit.
#
# Required env (loaded from $HERMES_HOME/.env or /root/.hermes/.env):
#   GATEWAY_URL=http://127.0.0.1:8080
#   IOS_MCP_TOKEN=<32-byte hex, must match backend/.env>  (shared with ios-tools)
#   IOS_MCP_USER_ID=<gateway DB user.id>                  (shared with ios-tools)
#
# Used in mcp_servers.cron-scheduler.command in /root/.hermes/config.yaml.

set -e

ENV_FILE="${HERMES_HOME:-/root/.hermes}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

: "${GATEWAY_URL:=http://127.0.0.1:8080}"
export GATEWAY_URL

# Resolve the script path. Default = standard VPS layout. Override via
# $CRON_SCHEDULER_STDIO_JS for local-docker dev or other layouts.
STDIO_JS="${CRON_SCHEDULER_STDIO_JS:-/root/repos/Hermes_agent/backend/dist/src/mcp/cron-scheduler-stdio.js}"

if [[ ! -f "${STDIO_JS}" ]]; then
  echo "[spawn-cron-scheduler-mcp] FATAL: ${STDIO_JS} not found. Did you run \`pnpm build\` in backend?" >&2
  exit 1
fi

exec node "${STDIO_JS}"
