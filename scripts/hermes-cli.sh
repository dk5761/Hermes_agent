#!/usr/bin/env bash
# Run a hermes command inside the container.
# - Prefers `docker compose exec` against the running `hermes` service so
#   interactive Ink/curses UIs (model picker, setup wizard) get a real raw
#   TTY. Falls back to `run --rm` if the container isn't up.
# - Forces TERM + size env so the Ink renderer knows how to draw.
#
# Examples:
#   ./scripts/hermes-cli.sh setup
#   ./scripts/hermes-cli.sh config set model openrouter/anthropic/claude-sonnet-4-5
#   ./scripts/hermes-cli.sh model
set -euo pipefail

if ! [ -t 0 ] || ! [ -t 1 ]; then
  echo "error: stdin/stdout is not a TTY — run this from a real terminal, not from a wrapper." >&2
  exit 1
fi

cols=$(tput cols 2>/dev/null || echo 120)
lines=$(tput lines 2>/dev/null || echo 40)
term=${TERM:-xterm-256color}

ENV_ARGS=(
  --env "TERM=$term"
  --env "COLUMNS=$cols"
  --env "LINES=$lines"
  --env "FORCE_COLOR=1"
  --env "HERMES_NONINTERACTIVE=0"
)

# Hermes binary lives in the venv; entrypoint adds it to PATH but exec bypasses
# the entrypoint, so we invoke the absolute path. --user hermes drops root.
HERMES_BIN=/opt/hermes/.venv/bin/hermes

if docker compose ps --status running --services 2>/dev/null | grep -qx hermes; then
  exec docker compose exec --user hermes "${ENV_ARGS[@]}" hermes "$HERMES_BIN" "$@"
fi

# Fallback: container not running. Spin a one-shot — entrypoint runs here so
# the bare `hermes` command works.
exec docker compose run --rm "${ENV_ARGS[@]}" hermes "$@"
