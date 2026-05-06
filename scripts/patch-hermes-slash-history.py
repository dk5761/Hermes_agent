#!/usr/bin/env python3
"""
Patch Hermes' slash worker so history-aware slash commands see the
session transcript.

Why this patch exists
─────────────────────
`tui_gateway.slash_worker` boots a `HermesCLI(resume=session_key)`
subprocess to handle `slash.exec` JSON-RPC calls. Slash commands that
inspect `self.conversation_history` — `/branch`, `/undo`, `/save`,
`/insights`, etc. — bail out with "No conversation to … — send a
message first." because cli.py's history is loaded LAZILY on the first
chat turn. The slash worker never enters `cli.run()`, so the lazy load
never runs.

Patch: after constructing `HermesCLI`, call `_preload_resumed_session()`
explicitly. It's a public-but-private helper that reads the session's
transcript from the SQLite session DB into `self.conversation_history`.
Output is already redirected so its `↻ Resumed session …` print is
swallowed.

Idempotency
───────────
Re-runnable. Marker comments `HERMES_PATCH:slash-worker-preload-history:start/end`
are checked first; if present, the script no-ops.

Usage
─────
    sudo python3 scripts/patch-hermes-slash-history.py
    sudo python3 scripts/patch-hermes-slash-history.py --target /custom/slash_worker.py
    sudo python3 scripts/patch-hermes-slash-history.py --check
    sudo python3 scripts/patch-hermes-slash-history.py --unpatch

After patching, restart `hermes-dashboard` so the slash worker pool is
rebuilt with the patched module:

    systemctl restart hermes-dashboard hermes-gateway

`scripts/post-hermes-update.sh` calls this script automatically.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_HERMES_LIB = Path("/usr/local/lib/hermes-agent")

# ─── Patch: preload history when slash worker resumes a session ──────────────
P_TARGET = "tui_gateway/slash_worker.py"
P_ANCHOR = "        cli = HermesCLI(model=args.model or None, compact=True, resume=args.session_key, verbose=False)"
P_MARK_START = "    # HERMES_PATCH:slash-worker-preload-history:start"
P_MARK_END = "    # HERMES_PATCH:slash-worker-preload-history:end"
P_BLOCK = f"""\
{P_MARK_START}
    # Without this, slash commands that read self.conversation_history
    # (e.g. /branch, /undo, /save) see an empty list because cli.py loads
    # history lazily inside run(), which the slash worker never enters.
    # Preload upfront so history-aware commands see the full transcript.
    try:
        if getattr(cli, "_resumed", False) and getattr(cli, "_session_db", None):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                cli._preload_resumed_session()
    except Exception as _exc:
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "HERMES_PATCH: slash-worker history preload failed: %s", _exc,
        )
{P_MARK_END}\
"""

# ─── Patch: refresh history before each slash command ───────────────────────
# The boot-time preload above runs once when the worker subprocess spawns.
# But Hermes' dashboard spawns the worker EAGERLY at session start, before
# the user's first turn has been written to the session DB. So the boot
# preload finds zero messages, and every later /branch / /undo / /save call
# in the same worker process sees the same stale empty list. Refreshing on
# every command is cheap (single SQLite read on the local FS) and fixes
# both the eager-spawn case and any divergence between live transcript and
# the worker's in-memory copy.
P2_ANCHOR = "def _run(cli: HermesCLI, command: str) -> str:"
P2_MARK_START = "    # HERMES_PATCH:slash-worker-refresh-history:start"
P2_MARK_END = "    # HERMES_PATCH:slash-worker-refresh-history:end"
P2_BLOCK = f"""\
{P2_MARK_START}
    # Re-load the transcript from the session DB on every command so the
    # worker sees turns that arrived after it spawned. Cheap; idempotent.
    try:
        if getattr(cli, "_resumed", False) and getattr(cli, "_session_db", None):
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                cli.conversation_history = []
                cli._preload_resumed_session()
    except Exception as _exc:
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "HERMES_PATCH: slash-worker history refresh failed: %s", _exc,
        )
{P2_MARK_END}\
"""

PATCHES = [
    {
        "name": "slash-worker-preload-history",
        "target": P_TARGET,
        "anchor": P_ANCHOR,
        "mark_start": P_MARK_START,
        "mark_end": P_MARK_END,
        "block": P_BLOCK,
    },
    {
        "name": "slash-worker-refresh-history",
        "target": P_TARGET,
        "anchor": P2_ANCHOR,
        "mark_start": P2_MARK_START,
        "mark_end": P2_MARK_END,
        "block": P2_BLOCK,
    },
]

# ─── implementation (mirrors patch-hermes-reload-mcp.py) ─────────────────────


def is_patched(src: str, p: dict) -> bool:
    return p["mark_start"] in src and p["mark_end"] in src


def apply_patch(src: str, p: dict) -> str | None:
    if p["anchor"] not in src:
        return None
    return src.replace(p["anchor"], p["anchor"] + "\n" + p["block"], 1)


def remove_patch(src: str, p: dict) -> str:
    if not is_patched(src, p):
        return src
    start = src.index(p["mark_start"])
    end = src.index(p["mark_end"]) + len(p["mark_end"])
    # Trim the leading newline injected when applying so removal restores
    # exactly the pre-patch source.
    if start > 0 and src[start - 1] == "\n":
        start -= 1
    return src[:start] + src[end:]


def resolve_target(lib_root: Path, p: dict, override: Path | None) -> Path:
    if override is not None:
        return override
    return lib_root / p["target"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--lib",
        type=Path,
        default=DEFAULT_HERMES_LIB,
        help="Hermes installation root (default: /usr/local/lib/hermes-agent)",
    )
    ap.add_argument(
        "--target",
        type=Path,
        help="override path to a single target (skips path resolution from --lib)",
    )
    ap.add_argument("--check", action="store_true", help="exit 0 if patched, 1 if not")
    ap.add_argument("--unpatch", action="store_true", help="remove the patch block")
    ns = ap.parse_args()

    failed = 0
    for p in PATCHES:
        target = resolve_target(ns.lib, p, ns.target)
        if not target.exists():
            print(f"[{p['name']}] target not found: {target}", file=sys.stderr)
            failed = 1
            continue
        src = target.read_text(encoding="utf-8")

        if ns.check:
            if is_patched(src, p):
                print(f"[{p['name']}] PATCHED   ({target})")
            else:
                print(f"[{p['name']}] NOT PATCHED ({target})")
                failed = 1
            continue

        if ns.unpatch:
            new_src = remove_patch(src, p)
            if new_src == src:
                print(f"[{p['name']}] not patched, nothing to remove ({target})")
                continue
            target.write_text(new_src, encoding="utf-8")
            print(f"[{p['name']}] removed ({target})")
            continue

        if is_patched(src, p):
            print(f"[{p['name']}] already patched ({target}), skipping")
            continue

        new_src = apply_patch(src, p)
        if new_src is None:
            print(
                f"[{p['name']}] anchor not found in {target}; "
                "patch needs an update for the current Hermes version",
                file=sys.stderr,
            )
            failed = 1
            continue

        target.write_text(new_src, encoding="utf-8")
        print(f"[{p['name']}] applied  ({target})")

    return failed


if __name__ == "__main__":
    sys.exit(main())
