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

DEFAULT_HERMES_LIB = Path("/usr/local/lib/hermes-agent")

# ─── Patch 1: clear caches on /reload-mcp ────────────────────────────────────
P1_TARGET = "gateway/run.py"
P1_ANCHOR = "            new_tools = await loop.run_in_executor(None, discover_mcp_tools)"
P1_MARK_START = "            # HERMES_PATCH:reload-mcp-clear-cache:start"
P1_MARK_END = "            # HERMES_PATCH:reload-mcp-clear-cache:end"
P1_BLOCK = f"""\
{P1_MARK_START}
            # Without this, existing sessions keep their cached AIAgent (and
            # frozen enabled_toolsets) forever — new MCP servers added via
            # patch-hermes-config.py never appear in already-open chats.
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
{P1_MARK_END}\
"""

# ─── Patch 2: dashboard discovers MCP tools at startup ───────────────────────
# Without this, the hermes-dashboard process starts with an empty MCP _tools
# registry. Chat agents (which run in the dashboard process via tui_gateway)
# have ZERO MCP tools until the user manually /reload-mcp. That means after
# every systemd restart, the user has to remember to reload — and the first
# chat after restart fails with "MCP server offline."
P2_TARGET = "hermes_cli/main.py"
P2_ANCHOR = '    embedded_chat = args.tui or os.environ.get("HERMES_DASHBOARD_TUI") == "1"'
P2_MARK_START = "    # HERMES_PATCH:dashboard-discover-mcp:start"
P2_MARK_END = "    # HERMES_PATCH:dashboard-discover-mcp:end"
P2_BLOCK = f"""\
{P2_MARK_START}
    # Discover MCP tools in the dashboard process so the chat agent (which
    # runs in this same process via tui_gateway) sees them on the first
    # turn after restart. Without this, every restart silently zeroes out
    # the MCP toolset until the user remembers to /reload-mcp.
    try:
        from tools.mcp_tool import discover_mcp_tools
        discover_mcp_tools()
    except Exception as _exc:
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "HERMES_PATCH: dashboard startup MCP discover failed: %s", _exc,
        )
{P2_MARK_END}\
"""

PATCHES = [
    {
        "name": "reload-mcp-clear-cache",
        "target": P1_TARGET,
        "anchor": P1_ANCHOR,
        "mark_start": P1_MARK_START,
        "mark_end": P1_MARK_END,
        "block": P1_BLOCK,
    },
    {
        "name": "dashboard-discover-mcp",
        "target": P2_TARGET,
        "anchor": P2_ANCHOR,
        "mark_start": P2_MARK_START,
        "mark_end": P2_MARK_END,
        "block": P2_BLOCK,
    },
]

# ─── implementation ──────────────────────────────────────────────────────────


def is_patched(src: str, p: dict) -> bool:
    return p["mark_start"] in src and p["mark_end"] in src


def apply_patch(src: str, p: dict) -> str | None:
    """Return patched source, or None if the anchor isn't found."""
    if p["anchor"] not in src:
        return None
    return src.replace(p["anchor"], p["anchor"] + "\n" + p["block"], 1)


def remove_patch(src: str, p: dict) -> str:
    if not is_patched(src, p):
        return src
    start = src.index(p["mark_start"])
    end = src.index(p["mark_end"]) + len(p["mark_end"])
    if start > 0 and src[start - 1] == "\n":
        start -= 1
    return src[:start] + src[end:]


def process_patch(p: dict, hermes_lib: Path, *, check: bool, unpatch: bool) -> int:
    target = hermes_lib / p["target"]
    if not target.exists():
        print(f"[patch:{p['name']}] target not found: {target}", file=sys.stderr)
        return 3

    src = target.read_text(encoding="utf-8")

    if check:
        if is_patched(src, p):
            print(f"[patch:{p['name']}] {target}: already patched")
            return 0
        if p["anchor"] not in src:
            print(f"[patch:{p['name']}] {target}: anchor missing", file=sys.stderr)
            print(f"        Anchor: {p['anchor'].strip()!r}", file=sys.stderr)
            return 2
        print(f"[patch:{p['name']}] {target}: needs patch")
        return 1

    if unpatch:
        if not is_patched(src, p):
            print(f"[patch:{p['name']}] {target}: not patched (no-op)")
            return 0
        new_src = remove_patch(src, p)
        backup = target.with_suffix(target.suffix + ".bak")
        backup.write_text(src, encoding="utf-8")
        target.write_text(new_src, encoding="utf-8")
        print(f"[patch:{p['name']}] unpatched {target}")
        return 0

    if is_patched(src, p):
        print(f"[patch:{p['name']}] {target}: already patched")
        return 0

    new_src = apply_patch(src, p)
    if new_src is None:
        print(f"[patch:{p['name']}] {target}: anchor not found", file=sys.stderr)
        print(f"        Looked for: {p['anchor'].strip()!r}", file=sys.stderr)
        print(
            f"        Hermes refactored {p['target']}. "
            f"Update PATCHES[{p['name']!r}] in this script.",
            file=sys.stderr,
        )
        return 4

    backup = target.with_suffix(target.suffix + ".bak")
    backup.write_text(src, encoding="utf-8")
    target.write_text(new_src, encoding="utf-8")
    print(f"[patch:{p['name']}] applied to {target}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--hermes-lib",
        type=Path,
        default=DEFAULT_HERMES_LIB,
        help=f"Path to hermes-agent install root (default: {DEFAULT_HERMES_LIB})",
    )
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--unpatch", action="store_true")
    args = parser.parse_args()

    if not args.hermes_lib.exists():
        print(f"[patch] hermes-lib not found: {args.hermes_lib}", file=sys.stderr)
        return 3

    overall = 0
    for p in PATCHES:
        rc = process_patch(p, args.hermes_lib, check=args.check, unpatch=args.unpatch)
        # In --check mode, 1 means "needs patch" — propagate as worst-case.
        # 2/3/4 mean error — treat as failures.
        if rc != 0:
            if args.check and rc == 1:
                overall = max(overall, 1)
            else:
                overall = max(overall, rc)

    if not args.check and not args.unpatch and overall == 0:
        print()
        print("Next: restart services so the new code is loaded.")
        print("  systemctl restart hermes-dashboard hermes-gateway hermes-cron")
    return overall


if __name__ == "__main__":
    sys.exit(main())
