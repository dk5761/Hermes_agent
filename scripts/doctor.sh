#!/usr/bin/env bash
# doctor.sh — local/VPS health check for the Hermes mobile stack.
#
# Run after deploys, Hermes updates, or confusing MCP/tool availability issues.
# It checks service state, gateway/Hermes reachability, required patch state,
# migration artifacts, and iOS MCP env wiring without printing secret values.

set -u

HERMES_HOME="${HERMES_HOME:-/root/.hermes}"
HERMES_LIB="${HERMES_LIB:-/usr/local/lib/hermes-agent}"
GATEWAY_URL="${GATEWAY_URL:-http://127.0.0.1:8080}"
HERMES_URL="${HERMES_URL:-http://127.0.0.1:9119}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

failures=0
warnings=0

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }

section() { c_blue ""; c_blue "==> $*"; }
pass()    { c_green "  OK   $*"; }
warn()    { c_yellow "  WARN $*"; warnings=$((warnings + 1)); }
fail()    { c_red "  FAIL $*"; failures=$((failures + 1)); }

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

unit_exists() {
  local unit="$1"
  local state
  have_cmd systemctl || return 1
  state="$(systemctl show -p LoadState --value "${unit}.service" 2>/dev/null || true)"
  [[ -n "$state" && "$state" != "not-found" ]]
}

check_unit() {
  local unit="$1"
  local required="${2:-1}"
  if ! unit_exists "$unit"; then
    if [[ "$required" == "1" ]]; then fail "${unit}.service missing"; else warn "${unit}.service not installed"; fi
    return
  fi
  if systemctl is-active --quiet "$unit"; then
    pass "${unit}.service active"
  else
    fail "${unit}.service not active"
  fi
}

http_code() {
  local url="$1"
  curl -sS -o /dev/null -m 8 -w '%{http_code}' "$url" 2>/dev/null || printf '000'
}

check_http() {
  local label="$1"
  local url="$2"
  local want="${3:-200}"
  local code
  code="$(http_code "$url")"
  if [[ "$code" == "$want" ]]; then
    pass "${label} = HTTP ${code}"
  else
    fail "${label} = HTTP ${code} (expected ${want})"
  fi
}

check_patch_config() {
  if [[ ! -f "${HERMES_HOME}/config.yaml" ]]; then
    fail "Hermes config missing: ${HERMES_HOME}/config.yaml"
    return
  fi
  local out="${TMP_DIR}/config.out"
  if python3 "${REPO_ROOT}/scripts/patch-hermes-config.py" --config "${HERMES_HOME}/config.yaml" --check >"$out" 2>&1; then
    pass "Hermes config patch desired state present"
  else
    local rc=$?
    if [[ "$rc" == "1" ]]; then
      fail "Hermes config drift detected; run patch-hermes-config.py"
    else
      fail "Hermes config check errored (rc=${rc})"
    fi
    sed 's/^/       /' "$out"
  fi
}

check_source_patch() {
  if [[ ! -d "${HERMES_LIB}" ]]; then
    fail "Hermes install root missing: ${HERMES_LIB}"
    return
  fi
  local out="${TMP_DIR}/source.out"
  if python3 "${REPO_ROOT}/scripts/patch-hermes-reload-mcp.py" --hermes-lib "${HERMES_LIB}" --check >"$out" 2>&1; then
    pass "Hermes source patches present"
  else
    local rc=$?
    if [[ "$rc" == "1" ]]; then
      fail "Hermes source patches missing; run patch-hermes-reload-mcp.py"
    else
      fail "Hermes source patch check errored (rc=${rc})"
    fi
    sed 's/^/       /' "$out"
  fi
}

check_token_scrape() {
  local html token
  html="$(curl -fsS -m 8 "${HERMES_URL}/" 2>/dev/null || true)"
  token="$(printf '%s' "$html" | tr '\n' ' ' | sed -n 's/.*window\.__HERMES_SESSION_TOKEN__[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [[ -n "$token" ]]; then
    pass "Hermes dashboard token is scrapeable"
  else
    fail "Hermes dashboard token not found in ${HERMES_URL}/"
  fi
}

check_migrations_artifact() {
  local dist_migrations="${REPO_ROOT}/backend/dist/src/db/migrations"
  local src_migrations="${REPO_ROOT}/backend/src/db/migrations"
  if [[ ! -d "$src_migrations" ]]; then
    fail "source migrations missing: ${src_migrations}"
    return
  fi
  if [[ -d "$dist_migrations" ]]; then
    pass "compiled migration assets present"
  else
    warn "compiled migration assets missing; production build must copy src/db/migrations into dist"
  fi
}

check_ios_env() {
  local env_file="${HERMES_HOME}/.env"
  local missing=()
  if [[ ! -f "$env_file" ]]; then
    warn "Hermes env file missing: ${env_file}"
    return
  fi
  for key in IOS_MCP_TOKEN IOS_MCP_USER_ID GATEWAY_URL; do
    if ! grep -q "^${key}=" "$env_file"; then
      missing+=("$key")
    fi
  done
  if [[ "${#missing[@]}" -eq 0 ]]; then
    pass "iOS MCP env keys present"
  else
    warn "iOS MCP env keys missing: ${missing[*]}"
  fi
}

check_mcp_cli() {
  if ! have_cmd hermes; then
    warn "hermes CLI not found in PATH; skipping mcp list"
    return
  fi
  local out="${TMP_DIR}/mcp.out"
  if hermes mcp list >"$out" 2>&1; then
    pass "hermes mcp list succeeds"
  else
    warn "hermes mcp list failed"
    sed 's/^/       /' "$out"
  fi
}

section "Configuration"
printf '  repo:        %s\n' "$REPO_ROOT"
printf '  HERMES_HOME: %s\n' "$HERMES_HOME"
printf '  HERMES_LIB:  %s\n' "$HERMES_LIB"
printf '  gateway:     %s\n' "$GATEWAY_URL"
printf '  hermes:      %s\n' "$HERMES_URL"

section "Services"
if have_cmd systemctl; then
  check_unit hermes-dashboard 1
  check_unit hermes-gateway 1
  check_unit hermes-cron 0
  check_unit nginx 0
else
  warn "systemctl unavailable; skipping service checks"
fi

section "HTTP Reachability"
check_http "gateway /health" "${GATEWAY_URL}/health" 200
check_http "Hermes /api/status" "${HERMES_URL}/api/status" 200
check_token_scrape

section "Patches And Config"
check_patch_config
check_source_patch
check_mcp_cli

section "Artifacts And Env"
check_migrations_artifact
check_ios_env

c_blue ""
if [[ "$failures" -gt 0 ]]; then
  c_red "Doctor: FAIL (${failures} failure(s), ${warnings} warning(s))"
  exit 1
fi
if [[ "$warnings" -gt 0 ]]; then
  c_yellow "Doctor: PASS with warnings (${warnings})"
  exit 0
fi
c_green "Doctor: PASS"
