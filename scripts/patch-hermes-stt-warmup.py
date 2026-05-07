#!/usr/bin/env python3
"""
Patch Hermes' tui_gateway/server.py so it pre-warms the faster-whisper
model in a background thread at startup.

Why this patch exists
─────────────────────
faster-whisper lazy-loads the local STT model on the FIRST `stt.transcribe`
RPC. For `large-v3-turbo` that's a 1.6 GB download from HuggingFace plus
a ~10 s load into memory — the user's first voice memo eats the full ~60 s
delay. Subsequent transcriptions are instant.

This patch spawns a background thread at server module-load time that:
  1. Reads `stt.local.model` from `~/.hermes/config.yaml`.
  2. Calls `tools.transcription_tools._load_local_whisper_model(model)`
     to download (if absent) + load into the module-global cache used by
     `_transcribe_local`.
  3. Logs `[stt-warmup] loaded {model} in {ms}ms` on success, or a
     warning + traceback on failure.

The thread is daemon=True so it never blocks dashboard shutdown. It runs
once per server.py import (i.e. once per dashboard process).

Idempotency
───────────
Re-runnable. Marker comments `HERMES_PATCH:stt-warmup:start/end` are
checked first; if present, the script no-ops.

Usage
─────
    sudo python3 scripts/patch-hermes-stt-warmup.py
    sudo python3 scripts/patch-hermes-stt-warmup.py --target /custom/server.py
    sudo python3 scripts/patch-hermes-stt-warmup.py --check
    sudo python3 scripts/patch-hermes-stt-warmup.py --unpatch

After patching, restart `hermes-dashboard` so the patched module reloads:

    systemctl restart hermes-dashboard

`scripts/post-hermes-update.sh` calls this script automatically.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_HERMES_LIB = Path("/usr/local/lib/hermes-agent")

# ─── Patch: STT warmup thread at server.py module load ──────────────────────
# Anchor: the `sys.excepthook = _panic_hook` line, which is module-level
# initialization that runs once on import. We inject AFTER it so the warmup
# thread spawns alongside the panic hook setup.
P_TARGET = "tui_gateway/server.py"
P_ANCHOR = "sys.excepthook = _panic_hook"
P_MARK_START = "# HERMES_PATCH:stt-warmup:start"
P_MARK_END = "# HERMES_PATCH:stt-warmup:end"

# The injected block. Plain string concatenation rather than f-string so
# the literal `{` and `}` of Python dict syntax don't fight the formatter.
P_BLOCK = (
    "\n"
    + P_MARK_START + "\n"
    + "# Pre-warm the local STT model in a background thread so the first\n"
    + "# `stt.transcribe` RPC doesn't pay the model-download + load cost.\n"
    + "# `_STT_READY` is module-level so the stt.transcribe handler can\n"
    + "# `wait()` on it before dispatching — gates concurrent loads that would\n"
    + "# otherwise race the warmup and corrupt the partial model file.\n"
    + "_STT_READY = threading.Event()\n"
    + "\n"
    + "def _stt_warmup() -> None:\n"
    + "    import time as _time\n"
    + "    import yaml as _yaml\n"
    + "    _t0 = _time.monotonic()\n"
    + "    try:\n"
    + "        _cfg_path = Path(_hermes_home) / 'config.yaml'\n"
    + "        if not _cfg_path.exists():\n"
    + "            logger.info('[stt-warmup] no config.yaml at %s; skipping', _cfg_path)\n"
    + "            return\n"
    + "        _cfg = _yaml.safe_load(_cfg_path.read_text(encoding='utf-8')) or {}\n"
    + "        _stt = _cfg.get('stt', {}) or {}\n"
    + "        if not _stt.get('enabled', True):\n"
    + "            logger.info('[stt-warmup] stt disabled in config; skipping')\n"
    + "            return\n"
    + "        if _stt.get('provider', 'local') != 'local':\n"
    + "            logger.info('[stt-warmup] provider=%s (not local); skipping', _stt.get('provider'))\n"
    + "            return\n"
    + "        _model = _stt.get('local', {}).get('model', 'base')\n"
    + "        logger.info(\"[stt-warmup] loading faster-whisper model '%s'...\", _model)\n"
    + "        from tools import transcription_tools as _tt\n"
    + "        _instance = _tt._load_local_whisper_model(_model)\n"
    + "        _tt._local_model = _instance\n"
    + "        _tt._local_model_name = _model\n"
    + "        _ms = int((_time.monotonic() - _t0) * 1000)\n"
    + "        logger.info('[stt-warmup] loaded %s in %dms', _model, _ms)\n"
    + "    except Exception as _exc:\n"
    + "        logger.warning('[stt-warmup] failed: %s', _exc, exc_info=True)\n"
    + "    finally:\n"
    + "        # Always set so transcribe requests don't hang forever even on\n"
    + "        # failure. If load failed, _local_model stays None and the\n"
    + "        # transcribe path returns its own error.\n"
    + "        _STT_READY.set()\n"
    + "\n"
    + "\n"
    + "threading.Thread(target=_stt_warmup, name='stt-warmup', daemon=True).start()\n"
    + P_MARK_END + "\n"
)

PATCHES = [
    {
        "name": "stt-warmup",
        "target": P_TARGET,
        "anchor": P_ANCHOR,
        "mark_start": P_MARK_START,
        "mark_end": P_MARK_END,
        "block": P_BLOCK,
    },
]

# ─── implementation (mirrors patch-hermes-stt-rpc.py) ────────────────────────


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
