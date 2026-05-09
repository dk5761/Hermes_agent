#!/usr/bin/env bash
#
# patch-local-hermes.sh — apply the same source patches we maintain for the
# VPS (post-hermes-update.sh) to the local docker `hermes` container.
#
# Why this exists: the patches modify Python files inside `/opt/hermes/...`
# in the running container. `docker compose restart hermes` keeps those
# edits (it just re-execs the entrypoint), but `docker compose down` /
# `docker compose up --force-recreate hermes` / `docker compose pull` wipes
# them — the image doesn't bake the patches in. After any of those
# rebuilds, re-run this script.
#
# Idempotent. Each patch script's own apply path is a no-op when already
# present.
#
# Usage:
#   ./scripts/patch-local-hermes.sh
#   FORCE_RESTART=1 ./scripts/patch-local-hermes.sh   # restart even if no change
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${CONTAINER:-hermes}"
LIB_PATH="${LIB_PATH:-/opt/hermes}"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
step()     { printf '\033[34m==> %s\033[0m\n' "$*"; }

# Patches in the order they should be applied. Mirrors post-hermes-update.sh.
PATCHES=(
  patch-hermes-reload-mcp.py
  patch-hermes-slash-history.py
  patch-hermes-stt-rpc.py
  patch-hermes-stt-warmup.py
  patch-hermes-stt-introspect.py
  patch-hermes-tts-kokoro.py
  patch-hermes-tts-warmup.py
)

if ! docker compose ps -q "$CONTAINER" >/dev/null 2>&1; then
  c_red "✗ docker compose service '$CONTAINER' not running. Bring it up first: docker compose up -d hermes"
  exit 1
fi

step "Step 1/3: copy patch scripts into the container"
for s in "${PATCHES[@]}"; do
  src="${REPO_ROOT}/scripts/${s}"
  if [[ ! -f "$src" ]]; then
    c_yellow "  skip: ${s} (not in repo)"
    continue
  fi
  docker cp "$src" "${CONTAINER}:/tmp/${s}" >/dev/null
  c_green "  copied ${s}"
done

step "Step 2/3: apply each patch with --lib ${LIB_PATH}"
# patch-hermes-reload-mcp.py uses --hermes-lib instead of --lib (legacy);
# all others use --lib. Branch per script to keep this one place that knows.
for s in "${PATCHES[@]}"; do
  case "$s" in
    patch-hermes-reload-mcp.py)
      flag="--hermes-lib"
      ;;
    *)
      flag="--lib"
      ;;
  esac
  c_yellow "  applying ${s}…"
  docker compose exec "$CONTAINER" python3 "/tmp/${s}" "$flag" "$LIB_PATH" 2>&1 \
    | sed 's/^/    /'
done

step "Step 3/3: restart hermes + recreate gateway"
# `restart` is enough for hermes itself to reload the patched Python files
# (the container FS state survives restart). Gateway uses
# `network_mode: service:hermes` — when hermes' container id stays the
# same, gateway is happy. If hermes was recreated (FORCE_RESTART) we
# also recreate the gateway so its network namespace re-attaches; this
# matches the fix from 2026-05-10's docker recovery.
docker compose restart "$CONTAINER" >/dev/null
sleep 4
docker compose up -d --force-recreate gateway >/dev/null
c_green "  restarted ${CONTAINER}; recreated gateway"

step "Done. Smoke check:"
sleep 3
http=$(curl -fsS -o /dev/null -w '%{http_code}' --connect-timeout 3 http://127.0.0.1:8080/health || echo 000)
if [[ "$http" == "200" ]]; then
  c_green "  ✓ gateway /health = 200"
else
  c_red "  ✗ gateway /health = ${http}"
  exit 1
fi
