#!/usr/bin/env bash
# Run a one-shot hermes command inside the container with the same volume
# mount as the dashboard service. Useful for first-time `hermes setup`,
# `hermes config set`, `hermes model`, etc. without installing Hermes locally.
#
# Examples:
#   ./scripts/hermes-cli.sh setup
#   ./scripts/hermes-cli.sh config set model openrouter/anthropic/claude-sonnet-4-5
#   ./scripts/hermes-cli.sh model
set -euo pipefail
exec docker compose run --rm -it hermes "$@"
