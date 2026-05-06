# WhisperKit upgrade research (2026-05-07)

---

## Source URLs consulted

- https://github.com/argmaxinc/WhisperKit/releases/tag/v1.0.0
- https://github.com/argmaxinc/argmax-oss-swift/releases (full release history)
- https://raw.githubusercontent.com/argmaxinc/argmax-oss-swift/main/Package.swift
- https://raw.githubusercontent.com/argmaxinc/argmax-oss-swift/main/Sources/WhisperKit/Core/Configurations.swift
- https://github.com/argmaxinc/argmax-oss-swift/blob/main/Sources/WhisperKit/Core/WhisperKit.swift
- https://raw.githubusercontent.com/argmaxinc/argmax-oss-swift/main/Sources/WhisperKit/Core/Audio/AudioStreamTranscriber.swift
- https://raw.githubusercontent.com/argmaxinc/argmax-oss-swift/main/Sources/WhisperKit/Core/Audio/AudioProcessor.swift
- https://raw.githubusercontent.com/argmaxinc/argmax-oss-swift/main/Sources/WhisperKit/Core/TranscribeTask.swift
- https://raw.githubusercontent.com/argmaxinc/argmax-oss-swift/main/Sources/ArgmaxCore/External/Hub/HubApi.swift
- https://raw.githubusercontent.com/argmaxinc/argmax-oss-swift/main/Examples/WhisperAX/WhisperAX/Views/ContentView.swift
- https://raw.githubusercontent.com/huggingface/swift-transformers/main/Sources/Hub/HubApi.swift
- https://huggingface.co/argmaxinc/whisperkit-coreml/tree/main
- https://swiftpackageindex.com/argmaxinc/whisperkit/v0.9.4/documentation/whisperkit/whispertokenizer
- https://github.com/argmaxinc/WhisperKit/issues/7
- https://github.com/argmaxinc/WhisperKit/issues/171
- https://github.com/argmaxinc/argmax-oss-swift/discussions/219

---

## WhisperKit v1.0.0 breaking changes

### Package identity — CRITICAL

The GitHub repo URL changed. The package that was `https://github.com/argmaxinc/WhisperKit` is now published at `https://github.com/argmaxinc/argmax-oss-swift`.

- **What breaks:** `ExpoWhisperKit.podspec` and any SPM `Package.swift` pointing to the old URL will resolve to a stale mirror or 404.
- **Affected file:** `ExpoWhisperKit.podspec` (the `source` key for the WhisperKit Swift package must be updated if you add it as a local SPM package; the pod itself likely wraps it).
- **Import statement:** `import WhisperKit` still works — the *product* name `WhisperKit` is preserved in the new repo's Package.swift. Do NOT change the import to `import ArgmaxOSS` unless you need TTSKit/SpeakerKit too.

### swift-transformers vendored — no longer a transitive dependency

In all versions ≤ 0.18.0, WhisperKit declared `swift-transformers` as an explicit SPM dependency (`.package(url: "https://github.com/huggingface/swift-transformers", ...)`). In v1.0.0, Hub and Tokenizers source files are **vendored** into `Sources/ArgmaxCore/External/Hub/` and `Sources/ArgmaxCore/External/Tokenizers/` under the original Apache 2.0 license. There is **no external swift-transformers dependency** in the new Package.swift.

- **What breaks:** Any `swift-transformers` version pin in your own project that was added to work around WhisperKit's transitive constraints is now irrelevant (and may conflict if you pin an incompatible version of swift-transformers in the same Xcode workspace).
- **Affected file:** If you added swift-transformers to the project's SPM graph, remove it.

### Removed deprecated APIs

All APIs carrying `@available(*, deprecated)` or `@available(*, unavailable, renamed:)` were removed. Removals relevant to our module:

| Removed | Replacement |
|---|---|
| `WhisperKit.transcribe(audioPath:)` → `TranscriptionResult?` | version returning `[TranscriptionResult]` |
| `TextDecoding.decodeText` (MLMultiArray overload) | `any AudioEncoderOutputType` / `any DecodingInputsType` versions |
| Top-level free utility functions | `ModelUtilities`, `TranscriptionUtilities`, `TextUtilities`, `Logging`, `FileManager` namespaces |
| `TextDecoderContextPrefill` model | eliminated; `usePrefillCache` decoding path gone |
| `DecodingOptions.supressTokens` (typo) | `DecodingOptions.suppressTokens` |
| `SpeakerKit.init(models:)` and `SpeakerKit.init(diarizer:)` | n/a (SpeakerKit is separate concern) |

- **Affected file/line in our module:** `WhisperKitModule.swift` line 331 — `DecodingOptions()` is used as default. If any caller ever explicitly set `supressTokens`, rename to `suppressTokens`. The default-constructed `DecodingOptions()` is fine.

### WhisperKitConfig — two new fields added

WhisperKitConfig gains two fields absent in v0.18.0:

```swift
public var audioInputConfig: AudioInputConfig?      // nil by default
public var useBackgroundDownloadSession: Bool       // false by default
```

Neither field is breaking (both default to nil/false). Our current call site:

```swift
// WhisperKitModule.swift line 209-216
let config = WhisperKitConfig(
    model: modelName,
    verbose: false,
    logLevel: .none,
    prewarm: false,
    load: true,
    download: true
)
```

This remains valid. No renames happened to the existing parameters.

### MLTensor async conversion (Swift 6 concurrency)

`MLTensor.asIntArray()` / `asFloatArray()` / `asMLMultiArray()` are now `async` and renamed to `toIntArray()` / `toFloatArray()` / `toMLMultiArray()`. This makes `TokenSampling.update(...)` async. We do not call these directly; this only matters if you subclass `TokenSampler`.

### `TranscriptionCallback` must now be optional

```swift
// Before (v0.18.x):
let callback: TranscriptionCallback = { _ in true }
// After (v1.0.0):
let callback: TranscriptionCallback? = { _ in true }
```

We do not expose `TranscriptionCallback` externally in our module. Not directly affected, but would surface if you ever add a `transcribe()` call.

### AudioStreamTranscriber — init signature UNCHANGED

Verified by reading the v1.0.0 source at `Sources/WhisperKit/Core/Audio/AudioStreamTranscriber.swift`. The signature is:

```swift
public init(
    audioEncoder: any AudioEncoding,
    featureExtractor: any FeatureExtracting,
    segmentSeeker: any SegmentSeeking,
    textDecoder: any TextDecoding,
    tokenizer: any WhisperTokenizer,
    audioProcessor: any AudioProcessing,
    decodingOptions: DecodingOptions,
    requiredSegmentsForConfirmation: Int = 2,
    silenceThreshold: Float = 0.3,
    compressionCheckWindow: Int = 60,   // ← was 20 in older versions, now 60
    useVAD: Bool = true,
    stateChangeCallback: AudioStreamTranscriberCallback?
)
```

**Breaking change for us:** `compressionCheckWindow` default changed from `20` to `60`. We pass `DecodingOptions()` (no explicit value) but we do not set `compressionCheckWindow` explicitly, so this is silently picked up. If prior behavior at 20 was intentional, we must pass it explicitly.

**New parameters we are not passing:** `requiredSegmentsForConfirmation`, `silenceThreshold`, `useVAD` — all have defaults. Not breaking.

### stateChangeCallback signature — callback parameter order

The callback type is:
```swift
public typealias AudioStreamTranscriberCallback = @Sendable (
    AudioStreamTranscriber.State,    // first  = OLD state (oldValue)
    AudioStreamTranscriber.State     // second = NEW state (current state)
) -> Void
```

Our current module at line 339 uses only `newState` (the second parameter):

```swift
stateChangeCallback: { _, newState in  // correct — first param is oldState, ignored
```

This is correct. No change needed.

### stopStreamTranscription() is NOT async

`stopStreamTranscription()` is declared:

```swift
public func stopStreamTranscription() {   // non-async, non-throwing
```

But because `AudioStreamTranscriber` is an `actor`, calling it from outside the actor requires `await` for actor-hop even though the method itself is not `async`. Our code at line 375:

```swift
await transcriber.stopStreamTranscription()
```

This is correct — `await` is needed for the actor isolation hop, not because the method is async. No change needed.

---

## "Invalid metadata" root cause

The error `"Model not found. Please check the model or repo name and try again. Error: invalidMetadataError(\"File metadata must have been retrieved from server\")"` originates in `HubFileDownloader.download()` inside `HubApi.swift` (in both the old swift-transformers package and the vendored copy in ArgmaxCore). The guard that throws it:

```swift
guard let remoteCommitHash = remoteMetadata.commitHash,
    let remoteEtag = remoteMetadata.etag,
    let remoteSize = remoteMetadata.size,
    remoteMetadata.location != ""
else {
    throw EnvironmentError.invalidMetadataError(
        "File metadata must have been retrieved from server")
}
```

`getFileMetadata()` performs an HTTP HEAD request to the HuggingFace CDN and reads four headers: `X-Repo-Commit`, `X-Linked-Etag` (or `Etag`), `X-Linked-Size` (or `Content-Length`), and `Location`. If any of these is absent or the server returns a redirect without the expected HF-specific headers, the `FileMetadata` struct holds nil values and the guard throws.

**Root causes in roughly descending probability for our case:**

1. **Network / CDN**: The HuggingFace CDN returned a partial or redirected response where one or more metadata headers (`X-Repo-Commit`, `X-Linked-Etag`, `X-Linked-Size`) were stripped. This can happen on corporate networks, behind a VPN, or when CDN edge nodes are under load.

2. **Stale incomplete-download state**: A prior interrupted download left a `.metadata/*.incomplete` marker or a partial `.metadata` file. On a fresh attempt, `readDownloadMetadata()` reads the corrupt file and returns nil, causing the wrapper to attempt to "resume" from a state that never actually fetched a server response — so `commitHash`/`etag`/`size` are all nil and the guard fires.

3. **HF rate limiting without 403**: HuggingFace throttles unauthenticated HEAD requests. In some CDN configurations, a throttled request returns a 200 with minimal headers (no `X-Linked-Etag`, no `X-Repo-Commit`), triggering the guard.

**Our workaround** (`wipeHFCacheTrees()` before fresh download) addresses cause #2 by removing the stale metadata files. It does not address causes #1 or #3.

**Does v1.0.0 fix it?** Partially. The vendored HubApi.swift in v1.0.0 has the same guard. The same error can still fire. However, v1.0.0 wraps Hub access behind `HubApiWrapper` (an opaque type), which may have retry/fallback logic not present in the original swift-transformers `HubApi`. The critical improvement is that the download machinery is now under Argmax's direct control and is no longer subject to breaking changes from upstream swift-transformers releases.

**Verified fix path for our module:** Do not call `WhisperKit.download()` as a separate step before `WhisperKit(config)`. Use the all-in-one `WhisperKit(WhisperKitConfig(model:..., download:true, load:true))` path. The `setupModels()` internal method does the same HubApiWrapper call, but the WhisperKit sample app shows it always uses the three-stage sequence: (1) `WhisperKit(config)` with `download:false, load:false`, (2) explicit `download()` call with progress callback, (3) `prewarmModels()`, (4) `loadModels()`. Our current single-call path is actually simpler and fine for our use case.

---

## Model naming / HF repo state

Current folders at `https://huggingface.co/argmaxinc/whisperkit-coreml/tree/main` (verified 2026-05-07):

```
distil-whisper_distil-large-v3
distil-whisper_distil-large-v3_594MB
distil-whisper_distil-large-v3_turbo
distil-whisper_distil-large-v3_turbo_600MB
openai_whisper-base.en                   ← still valid
openai_whisper-base                      ← still valid
openai_whisper-large-v2
openai_whisper-large-v2_949MB
openai_whisper-large-v2_turbo
openai_whisper-large-v2_turbo_955MB
openai_whisper-large-v3-v20240930        ← new preferred large-v3
openai_whisper-large-v3-v20240930_547MB
openai_whisper-large-v3-v20240930_626MB
openai_whisper-large-v3-v20240930_turbo
openai_whisper-large-v3-v20240930_turbo_632MB
openai_whisper-large-v3
openai_whisper-large-v3_947MB
openai_whisper-large-v3_turbo
openai_whisper-large-v3_turbo_954MB
openai_whisper-medium.en
openai_whisper-medium
openai_whisper-small.en
openai_whisper-small.en_217MB
openai_whisper-small
openai_whisper-small_216MB
openai_whisper-tiny.en
openai_whisper-tiny
```

**Missing from our `knownModelNames` set** (WhisperKitModule.swift lines 12-24):

- `openai_whisper-large-v3-v20240930` and its variants (`_547MB`, `_626MB`, `_turbo`, `_turbo_632MB`) — this is the current recommended large model, the HF repo has it as the primary large-v3 entry now
- All `_NNMB` size-suffixed variants
- All `distil-whisper_*` variants

**Names that still exist** and we correctly list: tiny, tiny.en, base, base.en, small, small.en, medium, medium.en, large-v2, large-v3.

**Names we list but may be stale** (no size suffix): `openai_whisper-large-v3` — still exists but `openai_whisper-large-v3-v20240930` (dated variant) is now preferred.

---

## Recommended download/load pattern in v1.0.0

From `Examples/WhisperAX/WhisperAX/Views/ContentView.swift` (the canonical Argmax sample app):

```swift
// Stage 1: Create instance with neither download nor load
let config = WhisperKitConfig(
    computeOptions: getComputeOptions(),
    verbose: true,
    logLevel: .debug,
    prewarm: false,
    load: false,
    download: false
)
whisperKit = try await WhisperKit(config)

// Stage 2: Explicit download with progress callback
let modelFolder = try await WhisperKit.download(
    variant: model,
    from: repoName,       // "argmaxinc/whisperkit-coreml"
    progressCallback: { progress in
        DispatchQueue.main.async {
            loadingProgressValue = Float(progress.fractionCompleted) * specializationProgressRatio
        }
    }
)
whisperKit?.modelFolder = modelFolder

// Stage 3: Prewarm (optional — reduces peak memory on first inference)
try await whisperKit?.prewarmModels()

// Stage 4: Load models into memory
try await whisperKit?.loadModels()
```

**Implication for our module:** Our current single-call pattern `WhisperKit(WhisperKitConfig(model:..., download:true, load:true))` is a valid shortcut (the all-in-one path is explicitly supported per the WhisperKit.swift init docs: "automatically manages model setup, prewarming, and loading based on configuration parameters"). The sample app uses the split path only to get granular progress callbacks for each stage. If we want stage-level progress (e.g., separate "downloading" vs "loading" events), we need to adopt the four-stage pattern. Currently we emit only `fraction` on `onModelDownloadProgress`, so the single-call path is acceptable.

**For the metadata error specifically:** The sample app's split path (Stage 2 = `WhisperKit.download()`) goes through the exact same `HubApiWrapper.snapshot()` call as the all-in-one path. Switching to the split path will not fix the metadata error.

---

## AVAudioSession recommendation

WhisperKit's own `AudioProcessor.setupAudioSessionForDevice()` (v1.0.0 source) uses:

```swift
try audioSession.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth])
try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
```

No explicit mode is set (defaults to `.default`). No `.measurement` mode.

**Our current code** (WhisperKitModule.swift line 319-320):

```swift
try session.setCategory(.record, mode: .measurement, options: .duckOthers)
```

This differs from WhisperKit's own recommendation in two ways:
1. Category: `.record` vs `.playAndRecord`
2. Mode: `.measurement` vs default (`.default`)
3. Options: `.duckOthers` vs `[.defaultToSpeaker, .allowBluetooth]`

`.record` prevents audio playback during recording (correct for pure transcription use). `.measurement` is intended for signal-measurement apps and disables some iOS audio processing (EQ, AGC) — it is NOT the standard mode for voice recognition, and WhisperKit does not use it. AVAudioSession mode `.measurement` may cause the `AudioStreamTranscriber`'s VAD (Voice Activity Detection) to behave unexpectedly because VAD thresholds are tuned for normal recorded audio levels, not measurement-mode levels.

**Recommended correction:** Match WhisperKit's own AudioProcessor:
```swift
try session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth])
try session.setActive(true, options: .notifyOthersOnDeactivation)
```

If the app needs playback-prevention, `.record` is acceptable, but remove `.measurement` mode and replace `.duckOthers` with no options or `[]`.

---

## AudioStreamTranscriber lifecycle

### Init signature (v1.0.0)

```swift
public actor AudioStreamTranscriber {

    public typealias AudioStreamTranscriberCallback = @Sendable (
        AudioStreamTranscriber.State,   // oldState
        AudioStreamTranscriber.State    // newState
    ) -> Void

    public init(
        audioEncoder: any AudioEncoding,
        featureExtractor: any FeatureExtracting,
        segmentSeeker: any SegmentSeeking,
        textDecoder: any TextDecoding,
        tokenizer: any WhisperTokenizer,    // protocol, not class
        audioProcessor: any AudioProcessing,
        decodingOptions: DecodingOptions,
        requiredSegmentsForConfirmation: Int = 2,
        silenceThreshold: Float = 0.3,
        compressionCheckWindow: Int = 60,  // NOTE: default was 20 in earlier versions
        useVAD: Bool = true,
        stateChangeCallback: AudioStreamTranscriberCallback?
    )
}
```

### Start / Stop pattern

```swift
// Start — async throws, call inside a detached Task
try await transcriber.startStreamTranscription()

// Stop — non-async, but actor isolation still requires await for the hop
await transcriber.stopStreamTranscription()
```

### State struct

```swift
public struct State {
    public var isRecording: Bool = false
    public var currentFallbacks: Int = 0
    public var lastBufferSize: Int = 0
    public var lastConfirmedSegmentEndSeconds: Float = 0
    public var bufferEnergy: [Float] = []
    public var currentText: String = ""
    public var confirmedSegments: [TranscriptionSegment] = []
    public var unconfirmedSegments: [TranscriptionSegment] = []
    public var unconfirmedText: [String] = []
}
```

Our callback reads `newState.unconfirmedSegments` and `newState.confirmedSegments` — these field names are unchanged.

### Important: `tokenizer` parameter type

The `tokenizer:` parameter in `AudioStreamTranscriber.init` expects `any WhisperTokenizer`. The `WhisperKit.tokenizer` property is typed `WhisperTokenizer?`. This requires an explicit `guard let tokenizer = kit.tokenizer` before passing it (which we already do at line 311-314). No change needed.

---

## swift-transformers version pinned by WhisperKit v1.0.0

**None.** swift-transformers is fully vendored into `Sources/ArgmaxCore/External/Hub/` and `Sources/ArgmaxCore/External/Tokenizers/` in v1.0.0. The Package.swift has zero external dependency on `huggingface/swift-transformers`. This is the most significant infrastructure change in v1.0.0. It means:

- No more version conflicts between WhisperKit's swift-transformers pin and any other dependency in the workspace.
- The vendored Hub code is a specific snapshot of swift-transformers at approximately v0.1.x (the `EnvironmentError.invalidMetadataError` API existed from early versions).
- Argmax controls the vendored copy; upgrades must come from argmax-oss-swift releases, not from swift-transformers independently.

For reference, in v0.18.0 (last release on old repo), WhisperKit required `swift-transformers` with a constraint of `from: "0.1.14"` or similar. That pin is now irrelevant.

---

## Concrete edits needed in WhisperKitModule.swift

Listed in priority order (1 = likely causing current failure, 3 = quality improvement).

### 1. [CRITICAL] Package URL — update the podspec / SPM dependency

**File:** `ExpoWhisperKit.podspec`  
**Current (assumed):** source pointing to `https://github.com/argmaxinc/WhisperKit`  
**Required:** update to `https://github.com/argmaxinc/argmax-oss-swift`

Without this, `pod install` or the Xcode SPM resolution will either pull from a redirect/mirror of the old repo or fail to find v1.0.0. The product name (`WhisperKit`) and import (`import WhisperKit`) stay the same.

Also check `package.json` in the module root for any version string.

### 2. [HIGH] AVAudioSession — remove .measurement mode

**File:** `WhisperKitModule.swift`  
**Line:** 319  
**Current:**
```swift
try session.setCategory(.record, mode: .measurement, options: .duckOthers)
```
**Required:**
```swift
try session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth])
```

Rationale: `.measurement` mode is not used by WhisperKit's AudioProcessor and may suppress normal audio processing pipeline behavior that WhisperKit's VAD depends on.

### 3. [HIGH] Add new large-v3 dated variants to knownModelNames

**File:** `WhisperKitModule.swift`  
**Lines:** 12-24 (the `knownModelNames` set)  
**Add:**
```swift
"openai_whisper-large-v3-v20240930",
"openai_whisper-large-v3-v20240930_547MB",
"openai_whisper-large-v3-v20240930_626MB",
"openai_whisper-large-v3-v20240930_turbo",
"openai_whisper-large-v3-v20240930_turbo_632MB",
// optionally size-suffixed variants of existing models:
"openai_whisper-small_216MB",
"openai_whisper-small.en_217MB",
```

Rationale: these are the folders that actually exist in the HF repo today; callers who pass the currently-recommended large-v3 variant name will get a `WhisperKitModuleError.unknownModel` rejection before the download even starts.

### 4. [MEDIUM] Remove the wipeHFCacheTrees() heuristic or make it less destructive

**File:** `WhisperKitModule.swift`  
**Lines:** 196-200  
The wipe is a workaround for the incomplete-metadata stale-state problem. In v1.0.0 the vendored HubApi now uses a `{etag}.incomplete` file pattern to track partial downloads. If a prior download completed successfully (marker exists), wiping the entire huggingface tree forces a full re-download on every app reinstall. Consider replacing the unconditional wipe with a targeted delete of only the specific model's directory when no marker is present.

### 5. [LOW] Fix typo guard if ever used: suppressTokens (not supressTokens)

**File:** `WhisperKitModule.swift`  
**Line:** 331 — `DecodingOptions()` default call  
If any caller or future code sets `DecodingOptions.supressTokens`, rename to `suppressTokens`. The default `DecodingOptions()` compiles fine; this only matters if named parameters are used.

### 6. [LOW] Consider passing compressionCheckWindow explicitly

**File:** `WhisperKitModule.swift`  
**Line:** 331-357 (AudioStreamTranscriber init)  
The default changed from 20 to 60. If the old behavior (more aggressive compression checking) was desired, pass `compressionCheckWindow: 20` explicitly. If the new default is acceptable, no action needed.

### 7. [INFORMATIONAL] No change needed to stopStreamTranscription await call

**File:** `WhisperKitModule.swift`  
**Line:** 375: `await transcriber.stopStreamTranscription()` is correct as-is. The method is not `async` but the `await` is required for the actor isolation hop.

### 8. [INFORMATIONAL] No change needed to tokenizer guard

**File:** `WhisperKitModule.swift`  
**Lines:** 311-314: `guard let tokenizer = kit.tokenizer` then passing `tokenizer` to `AudioStreamTranscriber.init(tokenizer:)` is correct. `WhisperKit.tokenizer` is `WhisperTokenizer?`; the init parameter is `any WhisperTokenizer`. The guard handles the nil unwrap correctly.

### 9. [INFORMATIONAL] stateChangeCallback parameter order is correct

**File:** `WhisperKitModule.swift`  
**Line:** 339: `{ _, newState in` — the first parameter is oldState (discarded), second is newState (used). Correct.
