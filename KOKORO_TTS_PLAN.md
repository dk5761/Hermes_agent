# Kokoro TTS — Hermes integration plan

**Goal:** add Kokoro as a local, open-source TTS provider in Hermes via the
existing patch-script pattern. The agent gains a fast, multilingual,
CPU-only voice that runs on the KVM2 VPS without GPU. Same architecture
as our STT integration.

**Architecture:** in-process Hermes patch. Kokoro loads into the
hermes-dashboard Python process; cached module-global; warmup at boot
mirrors the STT warmup pattern. Mobile clients use the existing
`tts.synthesize` JSON-RPC handler — no protocol changes.

```
mobile  → tts.synthesize WS RPC →  hermes
                                    └─ tts_tool._generate_kokoro
                                        └─ KModel (kokoro-onnx)
                                            ↓
                                       <wav bytes back to mobile>
```

**Three core principles:**

1. **Mirror the STT pattern.** Patch script writes a new
   `_generate_kokoro(text, output_path, config)` function into
   `tools/tts_tool.py`, next to `_generate_edge_tts`. Same dispatch.
2. **Background warmup.** Module-load thread pre-loads Kokoro so the
   first `tts.synthesize` doesn't pay the model-load cost.
3. **CPU-only via ONNX.** `kokoro-onnx` package over `kokoro` (PyTorch).
   Lighter footprint (310 MB vs 600 MB), faster cold-start, ~0.6 RTF
   on KVM2.

**Scope:**
- Kokoro provider in Hermes' TTS dispatch.
- Background warmup at module-load.
- Config block + default voice selection.
- One-shot pip install of `kokoro-onnx` + `soundfile` into Hermes venv.
- Wired into `post-hermes-update.sh` + `install-vps.sh` so it survives
  `hermes update` and fresh provisioning.

**Out of scope:**
- Auto language detection / voice switching based on response text.
  v1 ships with one voice. User flips voice via config.
- Voice cloning. Kokoro doesn't support it; that's a NeuTTS feature.
- Streaming TTS (return audio chunks as generated). v1 returns the full
  WAV after synthesis completes.
- Mobile UI for picking voice. v1 is config-driven.

---

## Locked decisions

1. **Backend:** `kokoro-onnx` (ONNX runtime). Lighter, CPU-friendly,
   no PyTorch transitive dep.
2. **Default voice:** `am_michael` (American English, male). Most-used
   voice; quality is solid.
3. **Output format:** 24 kHz mono WAV. Hermes' existing TTS write WAV;
   match what mobile expects. Use `soundfile` to write Float32 → WAV.
4. **Model files:** `kokoro-v1.0.onnx` (~310 MB) + `voices-v1.0.bin`
   (~27 MB). Cached at `/root/.hermes/tts/kokoro/` on first download.
   Survives `hermes update`.
5. **Warmup behavior:** background thread at server.py module-load
   loads the model + voices. Mirror the STT readiness gate so the
   first synthesis call doesn't race the warmup.
6. **Failure mode:** if Kokoro fails to load (OOM, model file
   corrupt), provider falls back to logging an error and returning
   the existing dispatch error. Doesn't crash the dashboard.

---

## Phase 0 — Dependency install (30 min)

### Files

- None — manual one-shot pip install + verification.

### Implementation

1. **Local docker:**
   ```bash
   docker exec hermes /opt/hermes/.venv/bin/pip install kokoro-onnx soundfile
   ```
2. **VPS:**
   ```bash
   ssh root@187.127.157.66 \
     'cd /usr/local/lib/hermes-agent && \
      .venv/bin/pip install kokoro-onnx soundfile'
   ```
3. **Test import + smoke synthesis:**
   ```bash
   docker exec hermes /opt/hermes/.venv/bin/python -c "
   from kokoro_onnx import Kokoro
   import soundfile as sf
   k = Kokoro('/path/to/kokoro-v1.0.onnx', '/path/to/voices-v1.0.bin')
   audio, sr = k.create('Hello world', voice='am_michael', speed=1.0, lang='en-us')
   sf.write('/tmp/test.wav', audio, sr)
   print('OK', sr, len(audio))
   "
   ```
   First run downloads the model (~340 MB total) from HuggingFace.
   Confirm `/tmp/test.wav` plays correctly via `aplay` or download.

### Acceptance

- Both envs have `kokoro-onnx` + `soundfile` installed.
- Manual smoke test produces a valid WAV that plays back.
- Note the ACTUAL pip-resolved disk paths for the model files —
  Phase 1 needs them.

### Edge cases

- **Disk space.** `kokoro-onnx` pulls `onnxruntime` (~150 MB) +
  Kokoro model (~340 MB). VPS has plenty of disk; KVM2 is 80 GB.
  Negligible.
- **First-run download.** kokoro-onnx auto-downloads the model on
  first instantiation. Phase 1 will trigger this from the warmup
  thread; phase 0 just confirms the download path works.

---

## Phase 1 — `patch-hermes-tts-kokoro.py` (3h)

### Files

- `scripts/patch-hermes-tts-kokoro.py` (NEW) — the patch script.
- It writes/edits `tools/tts_tool.py` (module-global cache + dispatch
  case + `_generate_kokoro` function).

### Patch structure

Three patches in one script (mirrors `patch-hermes-stt-rpc.py`'s
multi-patch array):

**Patch A — module-global Kokoro cache**

Anchor: an early line in `tts_tool.py` (after the existing imports).
Inject:
```python
# HERMES_PATCH:tts-kokoro-cache:start
# Module-global Kokoro instance — cached after first load so subsequent
# synthesis calls are instant. Loaded by the warmup thread at module-load
# (patch-hermes-tts-kokoro-warmup) or lazily on first `_generate_kokoro`
# call if warmup is absent.
_kokoro_instance = None
_kokoro_lock = None  # threading.Lock initialised on first use

def _get_kokoro_instance():
    """Lazy-load Kokoro on first synthesis. Subsequent calls return cached."""
    global _kokoro_instance, _kokoro_lock
    if _kokoro_instance is not None:
        return _kokoro_instance
    import threading
    if _kokoro_lock is None:
        _kokoro_lock = threading.Lock()
    with _kokoro_lock:
        if _kokoro_instance is not None:
            return _kokoro_instance
        from kokoro_onnx import Kokoro
        # kokoro-onnx auto-downloads to ~/.cache/huggingface/ on first use.
        # We rely on the default download path; no explicit model_path arg
        # needed. The package handles HF resolution.
        _kokoro_instance = Kokoro.from_pretrained()
        return _kokoro_instance
# HERMES_PATCH:tts-kokoro-cache:end
```

**Patch B — `_generate_kokoro` function**

Anchor: just before the existing `_generate_edge_tts` function
definition (so the new generator sits next to siblings).
Inject:
```python
# HERMES_PATCH:tts-kokoro-generate:start
def _generate_kokoro(text: str, output_path: str, tts_config: dict) -> str:
    """
    Synthesize text with Kokoro and write to a WAV file at output_path.

    Reads voice + speed + lang from tts_config['kokoro'], with sensible
    defaults. The cached Kokoro instance persists across calls.
    """
    import soundfile as sf

    kokoro_config = tts_config.get('kokoro', {}) or {}
    voice = kokoro_config.get('voice', 'am_michael')
    speed = float(kokoro_config.get('speed', tts_config.get('speed', 1.0)))
    lang = kokoro_config.get('lang', 'en-us')

    instance = _get_kokoro_instance()
    audio, sample_rate = instance.create(text, voice=voice, speed=speed, lang=lang)
    sf.write(output_path, audio, sample_rate)
    return output_path
# HERMES_PATCH:tts-kokoro-generate:end
```

**Patch C — provider dispatch case**

Anchor: the existing `if provider == "edge":` (or whichever the first
provider check is) inside Hermes' `_generate_tts(...)` dispatch
function. Inject AFTER it:
```python
    # HERMES_PATCH:tts-kokoro-dispatch:start
    if provider == "kokoro":
        return _generate_kokoro(text, output_path, tts_config)
    # HERMES_PATCH:tts-kokoro-dispatch:end
```

The exact anchor depends on the structure of Hermes' dispatcher.
Read `tts_tool.py` to find the `if/elif` chain that picks providers
based on `provider == "..."` strings.

### Acceptance

- `python3 scripts/patch-hermes-tts-kokoro.py --check` reports all three
  patches PATCHED.
- `pnpm typecheck` (backend) clean (unchanged — patch is Python-only).
- A manual JSON-RPC `tts.synthesize` call with `provider: kokoro`
  returns valid audio bytes.

### Edge cases

- **Model download in-process.** `Kokoro.from_pretrained()` blocks
  the dashboard thread for 30-60 s on first use. Hence Phase 2's
  warmup thread.
- **Concurrency.** Multiple synthesis calls hitting `_get_kokoro_instance`
  while it's loading — the lock pattern handles this. Same as the
  STT warmup deduplication.

---

## Phase 2 — Warmup patch (1.5h)

### Files

- `scripts/patch-hermes-tts-warmup.py` (NEW) — mirror of
  `patch-hermes-stt-warmup.py`.

### Implementation

Background thread spawned at `tui_gateway/server.py` module-load.
Reads `tts.provider` from `~/.hermes/config.yaml`. If `kokoro`, calls
`tools.tts_tool._get_kokoro_instance()` to populate the module-global
cache. Logs `[tts-warmup] loaded kokoro in {ms}ms`.

Patch shape exactly matches `patch-hermes-stt-warmup.py`:
- Anchor: `sys.excepthook = _panic_hook`
- Module-level `_TTS_READY = threading.Event()` event
- Background thread sets it on success or failure
- The dashboard's TTS handler can `wait()` on it before serving (so
  the first synthesis call blocks briefly if warmup is mid-flight).

### Acceptance

- After hermes-dashboard restart with `tts.provider: kokoro`,
  `[tts-warmup] loaded kokoro in <Xms>` appears in agent.log within
  ~30 s.
- Subsequent restarts warm in ~1-2 s (model already cached on disk).
- First user `tts.synthesize` request post-restart serves instantly.

### Edge cases

- **Provider not kokoro.** Skip warmup. Log `[tts-warmup] provider=edge
  (not kokoro); skipping`.
- **Model download takes minutes.** First-ever load downloads ~340 MB.
  Mirror of how STT warmup handles this (just logs progress and
  serves the request when ready).

---

## Phase 3 — Config update + flip provider (30 min)

### Files

- `scripts/patch-hermes-config.py` — add `kokoro` block to
  `_TTS_DEFAULTS` (or wherever the defaults live). Adds:
  ```yaml
  tts:
    kokoro:
      voice: am_michael
      speed: 1.0
      lang: en-us
  ```
- Manual flip on local + VPS:
  ```bash
  ssh root@187.127.157.66 'python3 -c "
    import yaml, pathlib
    p = pathlib.Path(\"/root/.hermes/config.yaml\")
    cfg = yaml.safe_load(p.read_text())
    cfg[\"tts\"][\"provider\"] = \"kokoro\"
    p.write_text(yaml.safe_dump(cfg, sort_keys=False))
  "'
  ```

### Acceptance

- Config has `tts.provider: kokoro` and `tts.kokoro.voice` fields.
- Restart hermes-dashboard. Warmup loads kokoro in background.

---

## Phase 4 — Deploy script wiring (30 min)

### Files

- `scripts/post-hermes-update.sh` — new step `2ce` for tts-kokoro and
  step `2cf` for tts-warmup, mirroring stt steps `2c/2cc`.
- `scripts/install-vps.sh` — parallel patch invocations near
  the existing patch block.

### Implementation

Add steps right after the STT patches:
```bash
step "Step 2ce/5: patch-hermes-tts-kokoro.py (kokoro local TTS provider)"
python3 "${REPO_ROOT}/scripts/patch-hermes-tts-kokoro.py"
python3 "${REPO_ROOT}/scripts/patch-hermes-tts-kokoro.py" --check

step "Step 2cf/5: patch-hermes-tts-warmup.py (pre-load kokoro at startup)"
python3 "${REPO_ROOT}/scripts/patch-hermes-tts-warmup.py"
python3 "${REPO_ROOT}/scripts/patch-hermes-tts-warmup.py" --check
```

Plus add `pip install kokoro-onnx soundfile` to install-vps.sh's
package install step.

### Acceptance

- Re-running `post-hermes-update.sh` is idempotent and reports all
  patches PATCHED.
- Fresh `install-vps.sh` on a clean VPS results in working Kokoro TTS
  without manual steps.

---

## Phase 5 — Manual test pass (30 min)

| Scenario | Expected |
|---|---|
| Send a text message, ask agent to TTS the response | Returns kokoro-generated audio with the configured voice |
| Switch voice via config (e.g. `bf_emma`) + restart | Next synthesis uses the new voice |
| Long text (>500 chars) | Synthesizes the full text without truncation |
| Hindi voice (`hf_*`) on Hindi text | Plausible Hindi pronunciation |
| Cold start | First request post-restart serves within 1-2 s (warmup loaded model) |
| Concurrent synthesis (3+ parallel) | All complete; CPU saturates at 2 vCPU; subsequent serial |

---

## Risks + open questions

- **Memory ceiling.** Kokoro (~400 MB) + faster-whisper-turbo (~1.5 GB)
  + Hermes core (~600 MB) + gateway (~150 MB) = ~2.7 GB on a 4 GB
  KVM2. Tight but workable. Watch `free -h` after first warmup.
- **Concurrency.** Kokoro's `create()` is CPU-bound. 2 vCPUs + 0.6 RTF
  = ~3 concurrent synthesizations realtime. Beyond that, queue at
  the dashboard's ThreadPoolExecutor (already handles this for STT).
- **Voice quality vs Edge.** Subjective. Edge-TTS is a well-tuned
  Microsoft cloud product; Kokoro is open-source. For US English
  Kokoro is comparable. Hindi voices may need tuning.
- **Model file storage.** Lives in `~/.cache/huggingface/`. On VPS
  that's `/root/.cache/huggingface/`. NOT in `~/.hermes/` — so Hermes
  data backups won't capture it. Acceptable; on-demand re-download.
- **Multilingual switching mid-conversation.** Out of scope for v1 —
  one voice config-wide. Can be added later via lang-detection on
  the response text.

---

## Total estimate

| Phase | Time |
|---|---|
| 0 — Dependency install | 30 min |
| 1 — `patch-hermes-tts-kokoro.py` (3 patches) | 3h |
| 2 — Warmup patch | 1.5h |
| 3 — Config flip | 30 min |
| 4 — Deploy script wiring | 30 min |
| 5 — Manual test pass | 30 min |
| **Total** | **~6.5h** |

Cuts if needed:
- Skip the warmup patch — first request pays the load cost (~30 s
  on first ever, ~1 s afterwards if cache is hot). Saves 1.5 h. UX
  hit only on the first request post-restart.
- Skip auto-config in install-vps.sh — manual config edits during
  deploy. Saves 30 min, adds toil.
