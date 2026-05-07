#!/usr/bin/env python3
"""
Patch Hermes' tools/tts_tool.py to add Kokoro as a local, CPU-only TTS provider.

Why this patch exists
─────────────────────
Hermes' TTS dispatch selects a synthesis backend by reading ``tts.provider``
from ``~/.hermes/config.yaml``. This patch wires in ``kokoro-onnx``, an
ONNX-runtime-backed port of the Kokoro TTS model, so ``provider: kokoro``
delivers fast, multilingual, on-device speech without a GPU or API key.

Three patches are applied to ``tools/tts_tool.py``:

  Patch A — module-global Kokoro cache + ``_get_kokoro_instance`` loader
      Inserted immediately AFTER the last top-level import line
      (``from tools.xai_http import hermes_xai_user_agent``). Adds a
      module-global ``_kokoro_instance`` / ``_kokoro_lock`` pair and a
      thread-safe lazy-loader that is also used by the warmup thread
      (``patch-hermes-tts-warmup.py``).

  Patch B — ``_generate_kokoro`` synthesis function
      Inserted immediately BEFORE the ``# Provider: Edge TTS`` section
      header / ``async def _generate_edge_tts`` definition. The new
      function is synchronous (Kokoro ONNX is CPU-bound sync); it calls
      ``_get_kokoro_instance().create(...)`` and writes the result to a
      WAV file via ``soundfile``.

  Patch C — provider dispatch case
      Inserted immediately AFTER the ``_generate_kittentts(...)`` call
      inside ``text_to_speech_tool``'s provider dispatch block, just
      before the ``else:`` default branch. Wires ``provider == "kokoro"``
      to ``_generate_kokoro``.

Idempotency
───────────
Re-runnable. Markers are checked first:
  Patch A: HERMES_PATCH:tts-kokoro-cache:start / end
  Patch B: HERMES_PATCH:tts-kokoro-generate:start / end
  Patch C: HERMES_PATCH:tts-kokoro-dispatch:start / end

Usage
─────
    docker cp scripts/patch-hermes-tts-kokoro.py hermes:/tmp/kokoro-patch.py
    docker exec hermes /opt/hermes/.venv/bin/python /tmp/kokoro-patch.py --lib /opt/hermes
    docker exec hermes /opt/hermes/.venv/bin/python /tmp/kokoro-patch.py --lib /opt/hermes --check
    docker exec hermes /opt/hermes/.venv/bin/python /tmp/kokoro-patch.py --lib /opt/hermes --unpatch

    # On VPS:
    python3 scripts/patch-hermes-tts-kokoro.py
    python3 scripts/patch-hermes-tts-kokoro.py --check

``scripts/post-hermes-update.sh`` calls this script automatically (step 2ce).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

DEFAULT_HERMES_LIB = Path("/usr/local/lib/hermes-agent")

P_TARGET = "tools/tts_tool.py"

# ─── Patch A — module-global Kokoro cache + lazy loader ──────────────────────
# Anchor: the last top-level import line in tts_tool.py. Inserting AFTER it
# keeps the cache + loader with the other module-level state. The line is
# unique in the file (only one xai_http import exists).
PA_ANCHOR = "from tools.xai_http import hermes_xai_user_agent"
PA_MARK_START = "# HERMES_PATCH:tts-kokoro-cache:start"
PA_MARK_END = "# HERMES_PATCH:tts-kokoro-cache:end"

# Plain string concatenation — avoids f-string brace-escaping for Python dicts
# inside the injected block (mirrors patch-hermes-stt-warmup.py).
PA_BLOCK = (
    "\n"
    + PA_MARK_START + "\n"
    + "# Module-global Kokoro instance — cached after first load. Subsequent\n"
    + "# synthesis calls are instant; the first call (or warmup thread) pays\n"
    + "# the ~1 s ONNX session-load cost once per dashboard process.\n"
    + "_kokoro_instance = None\n"
    + "_kokoro_lock = None  # threading.Lock initialised on first use\n"
    + "\n"
    + "\n"
    + "def _get_kokoro_instance():\n"
    + '    """Lazy-load Kokoro on first synthesis call. Thread-safe via double-checked lock.\n'
    + "\n"
    + "    Returns:\n"
    + "        Loaded kokoro_onnx.Kokoro instance (cached module-global).\n"
    + "\n"
    + "    Raises:\n"
    + "        ImportError: If kokoro-onnx or soundfile is not installed.\n"
    + "        FileNotFoundError: If the model or voices file is missing.\n"
    + '    """\n'
    + "    global _kokoro_instance, _kokoro_lock\n"
    + "    if _kokoro_instance is not None:\n"
    + "        return _kokoro_instance\n"
    + "    import threading\n"
    + "    if _kokoro_lock is None:\n"
    + "        _kokoro_lock = threading.Lock()\n"
    + "    with _kokoro_lock:\n"
    + "        if _kokoro_instance is not None:\n"
    + "            return _kokoro_instance\n"
    + "        from kokoro_onnx import Kokoro\n"
    + "        from hermes_constants import get_hermes_home\n"
    + "        from pathlib import Path as _Path\n"
    + "        _base = _Path(get_hermes_home()) / 'tts' / 'kokoro'\n"
    + "        _model_path = str(_base / 'kokoro-v1.0.onnx')\n"
    + "        _voices_path = str(_base / 'voices-v1.0.bin')\n"
    + "        logger.info('[kokoro] loading model from %s', _base)\n"
    + "        _kokoro_instance = Kokoro(_model_path, _voices_path)\n"
    + "        logger.info('[kokoro] model loaded and cached')\n"
    + "        return _kokoro_instance\n"
    + PA_MARK_END + "\n"
)

# ─── Patch B — _generate_kokoro synthesis function ───────────────────────────
# Anchor: the section header comment + function signature for Edge TTS.
# We insert BEFORE the comment so the new generator sits cleanly before the
# Edge section, alongside the other provider generators.
# Note: _generate_edge_tts is async. Kokoro ONNX is synchronous (CPU-bound);
# _generate_kokoro is sync. The dispatcher calls it directly (no asyncio.run).
PB_ANCHOR = (
    "# ===========================================================================\n"
    "# Provider: Edge TTS (free)\n"
    "# ==========================================================================="
)
PB_MARK_START = "# HERMES_PATCH:tts-kokoro-generate:start"
PB_MARK_END = "# HERMES_PATCH:tts-kokoro-generate:end"

PB_BLOCK = (
    PB_MARK_START + "\n"
    + "# ===========================================================================\n"
    + "# Provider: Kokoro (local, CPU-only, ONNX)\n"
    + "# ===========================================================================\n"
    + "def _generate_kokoro(text: str, output_path: str, tts_config: Dict[str, Any]) -> str:\n"
    + '    """Synthesize text with Kokoro ONNX and write to a WAV file.\n'
    + "\n"
    + "    Reads voice, speed, and lang from tts_config['kokoro']. Falls back to\n"
    + "    tts_config['speed'] for the speed value so the top-level speed knob is\n"
    + "    honoured. The Kokoro instance is loaded lazily and cached module-globally\n"
    + "    (see ``_get_kokoro_instance``).\n"
    + "\n"
    + "    Args:\n"
    + "        text:        Text to synthesise.\n"
    + "        output_path: Destination file path; MUST have a .wav extension.\n"
    + "        tts_config:  Full TTS config dict from ``_load_tts_config()``.\n"
    + "\n"
    + "    Returns:\n"
    + "        output_path unchanged (mirrors other provider generators).\n"
    + "\n"
    + "    Raises:\n"
    + "        ImportError: If kokoro-onnx or soundfile is not installed.\n"
    + "        FileNotFoundError: If the model or voices file is missing.\n"
    + '    """\n'
    + "    import soundfile as sf\n"
    + "    kokoro_config = tts_config.get('kokoro', {}) or {}\n"
    + "    voice = kokoro_config.get('voice', 'am_michael')\n"
    + "    speed = float(kokoro_config.get('speed', tts_config.get('speed', 1.0)))\n"
    + "    lang = kokoro_config.get('lang', 'en-us')\n"
    + "    logger.info('[kokoro] synthesising %d chars, voice=%s speed=%.2f lang=%s',\n"
    + "                len(text), voice, speed, lang)\n"
    + "    instance = _get_kokoro_instance()\n"
    + "    audio, sample_rate = instance.create(text, voice=voice, speed=speed, lang=lang)\n"
    + "    # Kokoro outputs WAV natively. If the caller wants .mp3/.ogg, write a\n"
    + "    # sibling .wav first then convert via ffmpeg (matches NeuTTS' pattern).\n"
    + "    wav_path = output_path\n"
    + "    if not output_path.endswith('.wav'):\n"
    + "        wav_path = output_path.rsplit('.', 1)[0] + '.wav'\n"
    + "    sf.write(wav_path, audio, sample_rate)\n"
    + "    if wav_path != output_path:\n"
    + "        ffmpeg = shutil.which('ffmpeg')\n"
    + "        if ffmpeg:\n"
    + "            conv_cmd = [ffmpeg, '-i', wav_path, '-y', '-loglevel', 'error', output_path]\n"
    + "            subprocess.run(conv_cmd, check=True, timeout=30)\n"
    + "            os.remove(wav_path)\n"
    + "        else:\n"
    + "            os.rename(wav_path, output_path)\n"
    + "    # Sidecar peaks: 80 RMS-bucketed floats normalised to [0, 1]. The mobile\n"
    + "    # gateway prefers this over ffmpeg-based extraction (free — we already\n"
    + "    # have the raw samples in memory). Best-effort: any failure leaves the\n"
    + "    # audio file in place and the gateway falls back to ffmpeg.\n"
    + "    try:\n"
    + "        import json as _json\n"
    + "        import numpy as _np\n"
    + "        samples = _np.asarray(audio, dtype=_np.float32).flatten()\n"
    + "        if samples.size > 0:\n"
    + "            buckets = 80\n"
    + "            chunk = max(1, samples.size // buckets)\n"
    + "            trimmed = samples[: chunk * buckets].reshape(buckets, chunk)\n"
    + "            rms = _np.sqrt(_np.mean(trimmed * trimmed, axis=1))\n"
    + "            peak_max = float(rms.max()) if rms.size else 0.0\n"
    + "            peaks = (rms / peak_max).tolist() if peak_max > 1e-9 else [0.0] * buckets\n"
    + "            with open(output_path + '.peaks.json', 'w', encoding='utf-8') as pf:\n"
    + "                _json.dump([round(float(v), 4) for v in peaks], pf)\n"
    + "    except Exception as _peaks_err:\n"
    + "        logger.warning('[kokoro] peaks sidecar failed: %s', _peaks_err)\n"
    + "    return output_path\n"
    + "\n"
    + "\n"
    + PB_MARK_END + "\n"
)

# ─── Patch C — provider dispatch case ────────────────────────────────────────
# Anchor: the _generate_kittentts call that ends the kittentts elif branch.
# We insert AFTER it (before the blank line + "else:") so the kokoro branch
# appears between kittentts and the default Edge/NeuTTS fallback.
PC_ANCHOR = "            _generate_kittentts(text, file_str, tts_config)"
PC_MARK_START = "        # HERMES_PATCH:tts-kokoro-dispatch:start"
PC_MARK_END = "        # HERMES_PATCH:tts-kokoro-dispatch:end"

PC_BLOCK = (
    "\n"
    + PC_MARK_START + "\n"
    + "        elif provider == 'kokoro':\n"
    + "            try:\n"
    + "                from kokoro_onnx import Kokoro as _Kokoro  # noqa: F401\n"
    + "            except ImportError:\n"
    + "                return json.dumps({\n"
    + "                    'success': False,\n"
    + "                    'error': (\n"
    + "                        \"Kokoro provider selected but 'kokoro-onnx' package is not installed. \"\n"
    + "                        \"Run: pip install kokoro-onnx soundfile\"\n"
    + "                    ),\n"
    + "                }, ensure_ascii=False)\n"
    + "            logger.info('Generating speech with Kokoro (local, ONNX)...')\n"
    + "            _generate_kokoro(text, file_str, tts_config)\n"
    + PC_MARK_END
)

PATCHES = [
    {
        "name": "tts-kokoro-cache",
        "target": P_TARGET,
        "anchor": PA_ANCHOR,
        "mark_start": PA_MARK_START,
        "mark_end": PA_MARK_END,
        "block": PA_BLOCK,
        "insert_before": False,
    },
    {
        "name": "tts-kokoro-generate",
        "target": P_TARGET,
        "anchor": PB_ANCHOR,
        "mark_start": PB_MARK_START,
        "mark_end": PB_MARK_END,
        "block": PB_BLOCK,
        "insert_before": True,
    },
    {
        "name": "tts-kokoro-dispatch",
        "target": P_TARGET,
        "anchor": PC_ANCHOR,
        "mark_start": PC_MARK_START,
        "mark_end": PC_MARK_END,
        "block": PC_BLOCK,
        "insert_before": False,
    },
]

# ─── implementation (mirrors patch-hermes-stt-rpc.py) ────────────────────────


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
    # Trim the leading newline injected during apply so removal is exact.
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
    ap.add_argument("--check", action="store_true", help="exit 0 if all patches present, 1 otherwise")
    ap.add_argument("--unpatch", action="store_true", help="remove all patch blocks")
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
