#!/usr/bin/env python3
"""
Patch Hermes' tui_gateway/server.py so it pre-warms the Kokoro TTS model
in a background thread at startup.

Why this patch exists
─────────────────────
Kokoro lazy-loads (~310 MB ONNX model + voices) on the FIRST `tts.synthesize`
RPC. Without warmup the first TTS request blocks 30-60 s on cold boot (model
download) or ~1-2 s on subsequent boots (disk-cached). This patch mirrors the
STT warmup pattern: spawns a daemon thread at server module-load time that
pre-loads the model so the first synthesis request is instant.

The thread:
  1. Reads `tts.provider` from `~/.hermes/config.yaml`.
  2. If provider == "kokoro", calls `tools.tts_tool._get_kokoro_instance()`.
  3. Sets `_TTS_READY` (threading.Event) so the synth handler can wait() on
     it and never race a mid-flight warmup.

If provider is not "kokoro" the warmup skips cleanly (no-op for edge-tts).

Idempotency
───────────
Re-runnable. Markers `HERMES_PATCH:tts-warmup:start/end` are checked first;
if present, the script no-ops.

Anchor choice
─────────────
Anchors on `# HERMES_PATCH:stt-warmup:end` — the last line written by the
sibling STT warmup patch. This is stable because:
  - The STT warmup patch is always applied before this one (deploy order).
  - The marker text is owned by our patch scripts, not Hermes upstream.
  - Injecting directly after puts the TTS warmup right next to its sibling,
    making the grouping clear in server.py.

Usage
─────
    sudo python3 scripts/patch-hermes-tts-warmup.py
    sudo python3 scripts/patch-hermes-tts-warmup.py --lib /opt/hermes
    sudo python3 scripts/patch-hermes-tts-warmup.py --check
    sudo python3 scripts/patch-hermes-tts-warmup.py --unpatch

After patching, restart `hermes-dashboard` to reload the patched module.
`scripts/post-hermes-update.sh` calls this script automatically.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_HERMES_LIB = Path("/usr/local/lib/hermes-agent")

# ─── Patch: TTS warmup thread at server.py module load ──────────────────────
P_TARGET = "tui_gateway/server.py"
P_ANCHOR = "# HERMES_PATCH:stt-warmup:end"
P_MARK_START = "# HERMES_PATCH:tts-warmup:start"
P_MARK_END = "# HERMES_PATCH:tts-warmup:end"

# Plain string concatenation — no f-string so literal { } don't need escaping.
P_BLOCK = (
    "\n"
    + P_MARK_START + "\n"
    + "# Pre-warm the local TTS model in a background thread so the first\n"
    + "# `tts.synthesize` request doesn't pay the model-load cost. Mirror of\n"
    + "# _stt_warmup. `_TTS_READY` is set when warmup finishes (success or\n"
    + "# failure); the synthesise handler can wait() on it.\n"
    + "_TTS_READY = threading.Event()\n"
    + "\n"
    + "def _tts_warmup() -> None:\n"
    + "    import time as _time\n"
    + "    import yaml as _yaml\n"
    + "    _t0 = _time.monotonic()\n"
    + "    try:\n"
    + "        _cfg_path = Path(_hermes_home) / 'config.yaml'\n"
    + "        if not _cfg_path.exists():\n"
    + "            logger.info('[tts-warmup] no config.yaml at %s; skipping', _cfg_path)\n"
    + "            return\n"
    + "        _cfg = _yaml.safe_load(_cfg_path.read_text(encoding='utf-8')) or {}\n"
    + "        _tts = _cfg.get('tts', {}) or {}\n"
    + "        _provider = (_tts.get('provider') or 'edge').lower().strip()\n"
    + "        if _provider != 'kokoro':\n"
    + "            logger.info('[tts-warmup] provider=%s (not kokoro); skipping', _provider)\n"
    + "            return\n"
    + "        logger.info('[tts-warmup] loading kokoro...')\n"
    + "        from tools import tts_tool as _tt\n"
    + "        _instance = _tt._get_kokoro_instance()\n"
    + "        _ms = int((_time.monotonic() - _t0) * 1000)\n"
    + "        # Sample-rate just for log clarity — instance.config might not exist.\n"
    + "        logger.info('[tts-warmup] loaded kokoro in %dms', _ms)\n"
    + "    except Exception as _exc:\n"
    + "        logger.warning('[tts-warmup] failed: %s', _exc, exc_info=True)\n"
    + "    finally:\n"
    + "        # Always set so future synth waits never hang forever.\n"
    + "        _TTS_READY.set()\n"
    + "\n"
    + "\n"
    + "threading.Thread(target=_tts_warmup, name='tts-warmup', daemon=True).start()\n"
    + P_MARK_END + "\n"
)

PATCHES = [
    {
        "name": "tts-warmup",
        "target": P_TARGET,
        "anchor": P_ANCHOR,
        "mark_start": P_MARK_START,
        "mark_end": P_MARK_END,
        "block": P_BLOCK,
    },
]

# ─── implementation (mirrors patch-hermes-stt-warmup.py) ─────────────────────


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
