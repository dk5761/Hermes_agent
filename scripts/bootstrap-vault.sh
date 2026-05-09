#!/usr/bin/env bash
#
# bootstrap-vault.sh — seed the local Obsidian vault with files that
# Obsidian Sync drops on the floor (notably `.hermes.md`, since most
# Obsidian Sync clients filter dotfiles by default).
#
# Idempotent. Safe to run on every dev-machine bootstrap or CI step.
# Files that already exist in the vault are NEVER overwritten — this is
# a seeder, not a sync. To re-seed a single file, delete it first.
#
# What gets seeded:
#   data/obsidian-vault/Hermes/.hermes.md
#     Project context manifest the agent reads on every task. Documents
#     the vault structure (raw/, wiki/, Memory/, etc.). Not synced from
#     production because it's a dotfile.
#
# Usage:
#   ./scripts/bootstrap-vault.sh                    # seed missing files
#   VAULT_DIR=/path/to/other/vault ./scripts/bootstrap-vault.sh
#
# Run this once after cloning the repo, before `docker compose up`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAULT_DIR="${VAULT_DIR:-${REPO_ROOT}/data/obsidian-vault}"
TEMPLATE_DIR="${REPO_ROOT}/scripts/templates/obsidian-vault"

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

if [[ ! -d "${TEMPLATE_DIR}" ]]; then
  c_red "✗ template dir not found: ${TEMPLATE_DIR}"
  exit 1
fi

# Walk the template tree. For each file, copy to the matching path under
# VAULT_DIR if (and only if) the destination does not already exist.
copied=0
skipped=0
while IFS= read -r -d '' src; do
  rel="${src#${TEMPLATE_DIR}/}"
  dst="${VAULT_DIR}/${rel}"
  dst_dir="$(dirname "${dst}")"
  mkdir -p "${dst_dir}"
  if [[ -e "${dst}" ]]; then
    c_yellow "  skip: ${rel} (already exists)"
    skipped=$((skipped + 1))
    continue
  fi
  cp "${src}" "${dst}"
  c_green "  seed: ${rel}"
  copied=$((copied + 1))
done < <(find "${TEMPLATE_DIR}" -type f -print0)

echo
echo "bootstrap complete: ${copied} seeded, ${skipped} skipped (already present)"
echo "vault root: ${VAULT_DIR}"
