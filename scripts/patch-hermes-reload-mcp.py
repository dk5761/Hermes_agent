#!/usr/bin/env python3
"""
Patch Hermes' source so /reload-mcp also clears cached agent state.

Why this patch exists
─────────────────────
Hermes' `_execute_mcp_reload` (in `gateway/run.py`) refreshes the global
MCP tools registry but does NOT touch:

  1. The `_RAW_CONFIG_CACHE` in `hermes_cli.config` — a process-wide
     mtime-keyed cache. Usually invalidates on file mtime change but can
     stick if the patcher writes config back atomically without
     incrementing mtime, or if config is re-read before the cache TTL.

  2. The `_sessions` dict in `tui_gateway.server` — keeps cached
     `AIAgent` instances per session. Each agent has a frozen
     `enabled_toolsets` list set at construction time. New MCP servers
     added to `platform_toolsets.cli` after a session was created do NOT
     appear in that session's agent — even after /reload-mcp succeeds.

Result: user runs /reload-mcp, sees toast "54 tools reloaded", then
asks the agent to use one of the new tools — agent says "I don't have
access to that toolset in this session". Only fixed by starting a new
chat (which constructs a fresh agent reading current config).

This patch injects two lines into `_execute_mcp_reload` that:
  - clear `_RAW_CONFIG_CACHE` (force fresh config reads)
  - clear `_sessions` (force fresh agent on next turn for every session)

Idempotency: re-runnable. Marker comments are checked first; if the
patch is already applied, the script no-ops.

Usage
─────
    sudo python3 scripts/patch-hermes-reload-mcp.py
    sudo python3 scripts/patch-hermes-reload-mcp.py --target /custom/run.py
    sudo python3 scripts/patch-hermes-reload-mcp.py --check
    sudo python3 scripts/patch-hermes-reload-mcp.py --unpatch

After patching, restart services so the new code is loaded:

    systemctl restart hermes-dashboard hermes-gateway hermes-cron

`scripts/post-hermes-update.sh` calls this script automatically — so a
fresh `hermes update` (which would overwrite the patched file with
upstream) gets re-patched on the same run.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_TARGET = Path("/usr/local/lib/hermes-agent/gateway/run.py")

ANCHOR = "            new_tools = await loop.run_in_executor(None, discover_mcp_tools)"

MARK_START = "            # HERMES_PATCH:reload-mcp-clear-cache:start"
MARK_END = "            # HERMES_PATCH:reload-mcp-clear-cache:end"

PATCH_BLOCK = f"""\
{MARK_START}
            # Custom patch (project: hermes-app). Without this, existing
            # sessions keep their cached AIAgent (and frozen enabled_toolsets)
            # forever — new MCP servers added via patch-hermes-config.py
            # never appear in already-open chats. See
            # `scripts/patch-hermes-reload-mcp.py` for full context.
            try:
                from hermes_cli import config as _hermes_cli_config
                if hasattr(_hermes_cli_config, "_RAW_CONFIG_CACHE"):
                    _hermes_cli_config._RAW_CONFIG_CACHE.clear()
            except Exception as _exc:
                logger.warning(
                    "HERMES_PATCH: clearing _RAW_CONFIG_CACHE failed: %s", _exc,
                )
            try:
                from tui_gateway import server as _tui_server
                if hasattr(_tui_server, "_sessions"):
                    _tui_server._sessions.clear()
            except Exception as _exc:
                logger.warning(
                    "HERMES_PATCH: clearing tui_gateway._sessions failed: %s", _exc,
                )
{MARK_END}\
"""

# ─── implementation ──────────────────────────────────────────────────────────


def is_patched(src: str) -> bool:
    return MARK_START in src and MARK_END in src


def apply_patch(src: str) -> str | None:
    """Return patched source, or None if the anchor isn't found."""
    if ANCHOR not in src:
        return None
    return src.replace(ANCHOR, ANCHOR + "\n" + PATCH_BLOCK, 1)


def remove_patch(src: str) -> str:
    """Strip the patch block. Returns original-looking source."""
    if not is_patched(src):
        return src
    start = src.index(MARK_START)
    end = src.index(MARK_END) + len(MARK_END)
    # Also drop the leading newline we inserted before MARK_START.
    if start > 0 and src[start - 1] == "\n":
        start -= 1
    return src[:start] + src[end:]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--target",
        type=Path,
        default=DEFAULT_TARGET,
        help=f"Path to gateway/run.py (default: {DEFAULT_TARGET})",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Dry-run; report state and exit. 0 = already patched, 1 = needs patch, 2 = anchor missing",
    )
    parser.add_argument(
        "--unpatch",
        action="store_true",
        help="Remove the patch (restores upstream source for our patch block only)",
    )
    args = parser.parse_args()

    target: Path = args.target
    if not target.exists():
        print(f"[patch] target not found: {target}", file=sys.stderr)
        print("        Pass --target to override, or check Hermes is installed.", file=sys.stderr)
        return 3

    src = target.read_text(encoding="utf-8")

    if args.check:
        if is_patched(src):
            print(f"[patch] {target}: already patched")
            return 0
        if ANCHOR not in src:
            print(f"[patch] {target}: anchor missing — Hermes may have refactored", file=sys.stderr)
            print(f"        Anchor: {ANCHOR.strip()!r}", file=sys.stderr)
            return 2
        print(f"[patch] {target}: needs patch")
        return 1

    if args.unpatch:
        if not is_patched(src):
            print(f"[patch] {target}: not currently patched (no-op)")
            return 0
        new_src = remove_patch(src)
        backup = target.with_suffix(target.suffix + ".bak")
        backup.write_text(src, encoding="utf-8")
        target.write_text(new_src, encoding="utf-8")
        print(f"[patch] unpatched {target} (backup: {backup})")
        return 0

    if is_patched(src):
        print(f"[patch] {target}: already patched")
        return 0

    new_src = apply_patch(src)
    if new_src is None:
        print(f"[patch] {target}: anchor not found", file=sys.stderr)
        print(f"        Looked for: {ANCHOR.strip()!r}", file=sys.stderr)
        print(
            "        Hermes likely changed `_execute_mcp_reload`. Read the function "
            "and update ANCHOR / PATCH_BLOCK in this script.",
            file=sys.stderr,
        )
        return 4

    backup = target.with_suffix(target.suffix + ".bak")
    backup.write_text(src, encoding="utf-8")
    target.write_text(new_src, encoding="utf-8")
    print(f"[patch] applied to {target} (backup: {backup})")
    print()
    print("Next: restart services so the new code is loaded.")
    print("  systemctl restart hermes-dashboard hermes-gateway hermes-cron")
    return 0


if __name__ == "__main__":
    sys.exit(main())
