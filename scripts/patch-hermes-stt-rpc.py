#!/usr/bin/env python3
"""
Patch Hermes' tui_gateway/server.py to add an ``stt.transcribe`` JSON-RPC
method that accepts a base64-encoded audio buffer, writes it to a temp file,
calls ``tools.transcription_tools.transcribe_audio``, and returns the
transcript.

Why this patch exists
─────────────────────
Hermes exposes a JSON-RPC server over WebSocket (tui_gateway/server.py).
The mobile gateway forwards ``stt.transcribe`` calls from the app to this
server. Without the patch the method is unknown and the gateway returns a
5030 "method not found" error.

Two patches are applied to the same file:

  Patch A — ``stt.transcribe`` handler
      Inserted immediately BEFORE the ``# ── Methods: insights ──...`` section
      header.  The voice section ends just above that header so the new
      method lives next to the voice methods (voice.listen, voice.tts, etc.)
      which is the most logical placement.

  Patch B — ``_LONG_HANDLERS`` entry
      ``transcribe_audio`` is synchronous and CPU-bound.  The server routes
      methods listed in the ``_LONG_HANDLERS`` frozenset to a
      ``ThreadPoolExecutor`` so they don't block the async event loop.
      ``stt.transcribe`` must be in that set.

Idempotency
───────────
Re-runnable. Markers are checked first:
  Patch A: HERMES_PATCH:stt-rpc:start / end
  Patch B: HERMES_PATCH:stt-rpc-long:start / end

Usage
─────
    sudo python3 scripts/patch-hermes-stt-rpc.py
    sudo python3 scripts/patch-hermes-stt-rpc.py --target /custom/server.py
    sudo python3 scripts/patch-hermes-stt-rpc.py --check
    sudo python3 scripts/patch-hermes-stt-rpc.py --unpatch

After patching, restart ``hermes-dashboard`` so the patched module is loaded:

    systemctl restart hermes-dashboard hermes-gateway

``scripts/post-hermes-update.sh`` calls this script automatically.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_HERMES_LIB = Path("/usr/local/lib/hermes-agent")

# ─── Patch A: stt.transcribe handler ─────────────────────────────────────────
# Anchor: the "insights" section header that immediately follows the voice
# methods section in server.py. We insert BEFORE it so the new method lands in
# the voice-adjacent block. apply_patch for this entry uses
# src.replace(anchor, block + anchor) rather than the usual insert-after
# approach used by other patchers.
PA_TARGET = "tui_gateway/server.py"
PA_ANCHOR = "# ── Methods: insights ────────────────────────────────────────────────"
PA_MARK_START = "# HERMES_PATCH:stt-rpc:start"
PA_MARK_END = "# HERMES_PATCH:stt-rpc:end"
PA_BLOCK = f"""\
{PA_MARK_START}
@method("stt.transcribe")
def _(rid, params: dict) -> dict:
    \"\"\"Transcribe a base64-encoded audio buffer.

    Params:
      audio_b64: base64-encoded audio bytes
      mime: mime type hint (e.g. "audio/m4a", "audio/mpeg"). Optional.

    Returns:
      {{success, transcript, provider}} on success
      {{success: False, error}} on failure
    \"\"\"
    import base64
    import os
    import tempfile

    # Wait for the warmup-loaded model before dispatching. Without this,
    # the FIRST request after a fresh boot triggers ITS OWN model download
    # while the warmup thread is also downloading — concurrent loads race
    # on the same partial cache file and corrupt it. The Event is set by
    # patch-hermes-stt-warmup.py when the warmup completes (success or
    # failure). Defensive lookup so this still works if the warmup patch
    # isn't applied.
    _ready = globals().get("_STT_READY")
    if _ready is not None and not _ready.wait(timeout=120):
        return _err(rid, 5042, "stt_warming_up")

    audio_b64 = params.get("audio_b64", "")
    mime = params.get("mime", "audio/m4a")
    if not audio_b64:
        return _err(rid, 5040, "audio_b64 missing")

    # Map mime → file extension. faster-whisper handles ffmpeg internally so
    # the extension is just for clarity in tempfile naming + supported-format
    # validation inside transcribe_audio.
    if "m4a" in mime or "aac" in mime:
        suffix = ".m4a"
    elif "mp3" in mime or "mpeg" in mime:
        suffix = ".mp3"
    elif "wav" in mime:
        suffix = ".wav"
    else:
        suffix = ".m4a"

    fd, path = tempfile.mkstemp(suffix=suffix, prefix="hermes-stt-")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(base64.b64decode(audio_b64))
        from tools.transcription_tools import transcribe_audio
        result = transcribe_audio(path)
        if not result.get("success", False):
            return _err(rid, 5041, result.get("error", "stt failed"))
        return _ok(rid, {{
            "success": True,
            "transcript": result.get("transcript", ""),
            "provider": result.get("provider", "unknown"),
        }})
    except Exception as exc:
        return _err(rid, 5041, str(exc))
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
{PA_MARK_END}


"""

# ─── Patch B: _LONG_HANDLERS entry ───────────────────────────────────────────
# Anchor: the "slash.exec" line inside the _LONG_HANDLERS frozenset literal.
# We insert AFTER it. The frozenset uses 8-space indentation; the new entry
# must match.
PB_TARGET = "tui_gateway/server.py"
PB_ANCHOR = '        "slash.exec",'
PB_MARK_START = "        # HERMES_PATCH:stt-rpc-long:start"
PB_MARK_END = "        # HERMES_PATCH:stt-rpc-long:end"
PB_BLOCK = f"""\
{PB_MARK_START}
        "stt.transcribe",
{PB_MARK_END}\
"""

PATCHES = [
    {
        "name": "stt-rpc",
        "target": PA_TARGET,
        "anchor": PA_ANCHOR,
        "mark_start": PA_MARK_START,
        "mark_end": PA_MARK_END,
        "block": PA_BLOCK,
        # insert_before=True means we place the block BEFORE the anchor line
        # rather than the usual insert-after used by other patchers.
        "insert_before": True,
    },
    {
        "name": "stt-rpc-long",
        "target": PB_TARGET,
        "anchor": PB_ANCHOR,
        "mark_start": PB_MARK_START,
        "mark_end": PB_MARK_END,
        "block": PB_BLOCK,
        "insert_before": False,
    },
]

# ─── implementation ───────────────────────────────────────────────────────────


def is_patched(src: str, p: dict) -> bool:
    return p["mark_start"] in src and p["mark_end"] in src


def apply_patch(src: str, p: dict) -> str | None:
    if p["anchor"] not in src:
        return None
    if p.get("insert_before"):
        # Place block immediately before the anchor line.
        return src.replace(p["anchor"], p["block"] + p["anchor"], 1)
    else:
        # Place block immediately after the anchor line (default behaviour).
        return src.replace(p["anchor"], p["anchor"] + "\n" + p["block"], 1)


def remove_patch(src: str, p: dict) -> str:
    if not is_patched(src, p):
        return src
    start = src.index(p["mark_start"])
    end = src.index(p["mark_end"]) + len(p["mark_end"])
    # Trim any leading newline injected during apply so removal restores the
    # pre-patch source exactly.
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
        help="override path to a single target file (skips path resolution from --lib)",
    )
    ap.add_argument("--check", action="store_true", help="exit 0 if both patches present, 1 otherwise")
    ap.add_argument("--unpatch", action="store_true", help="remove both patch blocks")
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
