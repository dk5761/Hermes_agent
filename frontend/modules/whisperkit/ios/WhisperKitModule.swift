import AVFoundation
import ExpoModulesCore
import WhisperKit

// MARK: - Valid model names

/// Recognised OpenAI Whisper model variants hosted on `argmaxinc/whisperkit-coreml`.
///
/// Names follow the `openai_whisper-<size>[.en]` convention used by WhisperKit
/// when constructing HuggingFace search paths.  Pass any of these strings to
/// `init` / `ensureModel`.
private let knownModelNames: Set<String> = [
  "openai_whisper-tiny",
  "openai_whisper-tiny.en",
  "openai_whisper-base",
  "openai_whisper-base.en",
  "openai_whisper-small",
  "openai_whisper-small_216MB",
  "openai_whisper-small.en",
  "openai_whisper-small.en_217MB",
  "openai_whisper-medium",
  "openai_whisper-medium.en",
  "openai_whisper-large",
  "openai_whisper-large-v2",
  "openai_whisper-large-v3",
  // Dated large-v3 variants — the currently recommended large model on HF
  "openai_whisper-large-v3-v20240930",
  "openai_whisper-large-v3-v20240930_547MB",
  "openai_whisper-large-v3-v20240930_626MB",
  "openai_whisper-large-v3-v20240930_turbo",
  "openai_whisper-large-v3-v20240930_turbo_632MB",
]

// MARK: - Module

/// Expo native module wrapping WhisperKit for on-device streaming transcription.
///
/// Recommended JS lifecycle:
///   1. `ensureModel(modelName)` — downloads if absent, no-op if cached.
///   2. `init(modelName)` — loads the model into memory (fast, model must be on disk).
///   3. `start()` → events → `stop()`
///   4. `release()` when the session is over.
///
/// Legacy convenience: calling `init(modelName)` still works end-to-end — it
/// internally calls `ensureModel` then loads.
///
/// Thread safety: all mutable state lives in `WhisperKitBackend`, a Swift actor.
public class WhisperKitModule: Module {
  private let backend = WhisperKitBackend()

  public func definition() -> ModuleDefinition {
    Name("WhisperKit")

    Events("onPartial", "onConfirmed", "onError", "onModelDownloadProgress")

    // -------------------------------------------------------------------------
    // ensureModel — download model if absent, emit progress events, resolve on
    // completion.  No-op if the model is already on disk.
    // -------------------------------------------------------------------------
    AsyncFunction("ensureModel") { [weak self] (modelName: String) async throws in
      guard let self else { return }
      guard knownModelNames.contains(modelName) else {
        throw WhisperKitModuleError.unknownModel(modelName)
      }
      try await self.backend.ensureModel(
        modelName: modelName,
        onProgress: { [weak self] fraction in
          self?.sendEvent("onModelDownloadProgress", ["fraction": fraction])
        }
      )
    }

    // -------------------------------------------------------------------------
    // isModelDownloaded — returns true if the model folder exists on disk.
    // -------------------------------------------------------------------------
    AsyncFunction("isModelDownloaded") { (modelName: String) async throws -> Bool in
      // True ONLY if the .download-complete marker exists. A bare directory
      // can be a stale partial download that would crash WhisperKit on load
      // (swift-transformers throws "Invalid metadata: File metadata must
      // have been retrieved from server" on incomplete cache state).
      guard let cacheBase = WhisperKitBackend.modelCacheBase() else { return false }
      let modelDir = cacheBase.appendingPathComponent(modelName, isDirectory: true)
      let marker = modelDir.appendingPathComponent(".download-complete")
      return FileManager.default.fileExists(atPath: marker.path)
    }

    // -------------------------------------------------------------------------
    // modelLocationOnDisk — returns the resolved model folder path, or nil.
    // -------------------------------------------------------------------------
    AsyncFunction("modelLocationOnDisk") { (modelName: String) async throws -> String? in
      guard let cacheBase = WhisperKitBackend.modelCacheBase() else { return nil }
      let modelDir = cacheBase.appendingPathComponent(modelName, isDirectory: true)
      guard FileManager.default.fileExists(atPath: modelDir.path) else { return nil }
      return modelDir.path
    }

    // -------------------------------------------------------------------------
    // init — convenience: ensureModel + load in one call.
    // -------------------------------------------------------------------------
    AsyncFunction("init") { [weak self] (modelName: String) async throws in
      guard let self else { return }
      guard knownModelNames.contains(modelName) else {
        throw WhisperKitModuleError.unknownModel(modelName)
      }
      // Step A: download if absent.
      try await self.backend.ensureModel(
        modelName: modelName,
        onProgress: { [weak self] fraction in
          self?.sendEvent("onModelDownloadProgress", ["fraction": fraction])
        }
      )
      // Step B: load from disk.
      try await self.backend.load(modelName: modelName)
    }

    // -------------------------------------------------------------------------
    // start / stop / release — unchanged from Phase 1.
    // -------------------------------------------------------------------------

    /// Start microphone capture + streaming transcription pipeline.
    AsyncFunction("start") { [weak self] () async throws in
      guard let self else { return }
      try await self.backend.start(
        onPartial: { [weak self] text, segmentId in
          self?.sendEvent("onPartial", ["text": text, "segmentId": segmentId])
        },
        onConfirmed: { [weak self] text, segmentId in
          self?.sendEvent("onConfirmed", ["text": text, "segmentId": segmentId])
        },
        onError: { [weak self] code, message in
          self?.sendEvent("onError", ["code": code, "message": message])
        }
      )
    }

    /// Stop the stream; remaining tokens are flushed as confirmed before resolving.
    AsyncFunction("stop") { [weak self] () async throws in
      guard let self else { return }
      try await self.backend.stop()
    }

    /// Free the WhisperKit instance and release the audio session.
    AsyncFunction("release") { [weak self] () async throws in
      guard let self else { return }
      await self.backend.release()
    }
  }
}

// MARK: - Backend actor

/// Serialises all mutable WhisperKit state via Swift structured concurrency.
private actor WhisperKitBackend {
  private var whisperKit: WhisperKit?
  private var streamTranscriber: AudioStreamTranscriber?

  // Tracks how many confirmed segments have been emitted across this stream.
  private var emittedConfirmedCount: Int = 0
  private var nextSegmentId: Int = 0

  // MARK: Cache directory

  /// The directory under which WhisperKit (via HuggingFace Hub) stores downloaded
  /// model variants.  Path: `<Caches>/huggingface/models/argmaxinc/whisperkit-coreml/`
  ///
  /// This mirrors the path that `WhisperKit.download()` writes to when
  /// `downloadBase` is nil (i.e. the default).
  nonisolated static func modelCacheBase() -> URL? {
    guard
      let cachesDir = FileManager.default.urls(
        for: .cachesDirectory,
        in: .userDomainMask
      ).first
    else { return nil }
    return cachesDir
      .appendingPathComponent("huggingface/models/argmaxinc/whisperkit-coreml",
                              isDirectory: true)
  }

  // MARK: ensureModel

  /// Downloads the model variant from HuggingFace if it isn't cached locally.
  ///
  /// Emits progress in [0, 1) via `onProgress` while downloading.  Emits 1.0
  /// on completion (whether a fresh download or a cache hit).
  ///
  /// Uses `WhisperKit.download(variant:progressCallback:)` — a static async
  /// method that wraps HuggingFace Hub's `snapshot()` call with a real
  /// `Foundation.Progress` progress callback.
  func ensureModel(
    modelName: String,
    onProgress: @escaping @Sendable (Double) -> Void
  ) async throws {
    // If the model is already loaded for this variant, no work to do.
    if whisperKit != nil {
      onProgress(1.0)
      return
    }

    // Wipe only the specific model variant directory when no completion marker
    // exists.  v1.0.0's vendored HubApi uses an `{etag}.incomplete` sentinel
    // inside each model folder; stale partial state from a prior crash can
    // produce "Invalid metadata: File metadata must have been retrieved from
    // server" on the next attempt.  A targeted wipe avoids forcing re-downloads
    // of other already-complete variants.
    let markerExists = WhisperKitBackend.markerExistsForModel(modelName)
    if !markerExists {
      WhisperKitBackend.wipePartialDownload(for: modelName)
    }

    NSLog("[whisperkit] init+load \(modelName) (markerExists=\(markerExists))")
    onProgress(0.0)

    // Use WhisperKit's all-in-one constructor — the canonical path used by
    // their sample apps.  It handles the download internally via its own
    // pipeline rather than the standalone `WhisperKit.download` helper which
    // hits a metadata-cache edge case in this swift-transformers version.
    let config = WhisperKitConfig(
      model: modelName,
      verbose: false,
      logLevel: .none,
      prewarm: false,
      load: true,
      download: true
    )

    do {
      let kit = try await WhisperKit(config)
      whisperKit = kit
      emittedConfirmedCount = 0
      nextSegmentId = 0

      // Write completion marker so future cold-starts skip the wipe.
      if let cacheBase = WhisperKitBackend.modelCacheBase() {
        let modelDir = cacheBase.appendingPathComponent(modelName, isDirectory: true)
        if !FileManager.default.fileExists(atPath: modelDir.path) {
          try? FileManager.default.createDirectory(
            at: modelDir, withIntermediateDirectories: true)
        }
        let marker = modelDir.appendingPathComponent(".download-complete")
        FileManager.default.createFile(atPath: marker.path, contents: nil)
      }

      NSLog("[whisperkit] init+load complete: \(modelName)")
      onProgress(1.0)
    } catch {
      NSLog("[whisperkit] init+load failed: \(String(describing: error))")
      throw error
    }
  }

  /// Returns true if the on-disk completion marker exists for this model.
  nonisolated static func markerExistsForModel(_ modelName: String) -> Bool {
    guard let cacheBase = modelCacheBase() else { return false }
    let modelDir = cacheBase.appendingPathComponent(modelName, isDirectory: true)
    let marker = modelDir.appendingPathComponent(".download-complete")
    return FileManager.default.fileExists(atPath: marker.path)
  }

  /// Removes the specific model variant directory (and its sibling in Documents
  /// if present) to clear stale partial-download state.  Only the requested
  /// variant is affected; other cached models are untouched.
  ///
  /// - Parameter modelName: The WhisperKit model variant folder name, e.g.
  ///   `"openai_whisper-large-v3-v20240930"`.
  nonisolated static func wipePartialDownload(for modelName: String) {
    let dirs: [FileManager.SearchPathDirectory] = [.cachesDirectory, .documentDirectory]
    for dir in dirs {
      guard let base = FileManager.default.urls(for: dir, in: .userDomainMask).first
      else { continue }
      let modelDir = base
        .appendingPathComponent("huggingface/models/argmaxinc/whisperkit-coreml",
                                isDirectory: true)
        .appendingPathComponent(modelName, isDirectory: true)
      guard FileManager.default.fileExists(atPath: modelDir.path) else { continue }
      NSLog("[whisperkit] wiping partial download: \(modelDir.path)")
      try? FileManager.default.removeItem(at: modelDir)
    }
  }

  // MARK: load

  /// Load a model that is already on disk into memory.
  /// Now a no-op if `ensureModel` already loaded it (the all-in-one path).
  func load(modelName: String) async throws {
    if whisperKit != nil { return }
    try await ensureModel(modelName: modelName, onProgress: { _ in })
  }

  // MARK: initialize (kept for internal use by the combined init bridge method)

  /// Convenience: ensureModel then load.  Used by the `init` bridge function.
  func initialize(
    modelName: String,
    onProgress: @escaping @Sendable (Double) -> Void
  ) async throws {
    try await ensureModel(modelName: modelName, onProgress: onProgress)
    try await load(modelName: modelName)
  }

  // MARK: start

  func start(
    onPartial: @escaping @Sendable (String, Int) -> Void,
    onConfirmed: @escaping @Sendable (String, Int) -> Void,
    onError: @escaping @Sendable (String, String) -> Void
  ) async throws {
    guard let kit = whisperKit else {
      onError("NOT_INITIALIZED", "Call init(modelName:) before start()")
      throw WhisperKitModuleError.notInitialized
    }
    guard streamTranscriber == nil else {
      onError("ALREADY_RUNNING", "A transcription stream is already active")
      throw WhisperKitModuleError.alreadyRunning
    }
    guard let tokenizer = kit.tokenizer else {
      onError("NOT_INITIALIZED", "WhisperKit tokenizer was not loaded")
      throw WhisperKitModuleError.notInitialized
    }

    // Activate the audio session for recording.
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetooth])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      onError(
        "AUDIO_SESSION_ERROR",
        "Failed to activate audio session: \(error.localizedDescription)"
      )
      throw WhisperKitModuleError.audioSessionError(error)
    }

    let emittedBox = EmittedCountBox()

    let transcriber = AudioStreamTranscriber(
      audioEncoder: kit.audioEncoder,
      featureExtractor: kit.featureExtractor,
      segmentSeeker: kit.segmentSeeker,
      textDecoder: kit.textDecoder,
      tokenizer: tokenizer,
      audioProcessor: kit.audioProcessor,
      decodingOptions: DecodingOptions(),
      stateChangeCallback: { _, newState in
        let partialText = newState.unconfirmedSegments
          .map(\.text)
          .joined(separator: " ")
          .trimmingCharacters(in: .whitespaces)
        if !partialText.isEmpty {
          onPartial(partialText, emittedBox.count)
        }

        let allConfirmed = newState.confirmedSegments
        let newConfirmed = allConfirmed.dropFirst(emittedBox.count)
        for segment in newConfirmed {
          let text = segment.text.trimmingCharacters(in: .whitespaces)
          guard !text.isEmpty else { continue }
          onConfirmed(text, emittedBox.count)
          emittedBox.increment()
        }
      }
    )

    streamTranscriber = transcriber

    Task.detached { [weak self] in
      do {
        try await transcriber.startStreamTranscription()
      } catch {
        onError("TRANSCRIPTION_ERROR", error.localizedDescription)
        await self?.clearTranscriber()
      }
    }
  }

  // MARK: stop

  func stop() async throws {
    guard let transcriber = streamTranscriber else { return }
    await transcriber.stopStreamTranscription()
    try? await Task.sleep(nanoseconds: 300_000_000)
    clearTranscriber()
    deactivateAudioSession()
  }

  // MARK: release

  func release() async {
    await streamTranscriber?.stopStreamTranscription()
    clearTranscriber()
    whisperKit = nil
    emittedConfirmedCount = 0
    nextSegmentId = 0
    deactivateAudioSession()
  }

  // MARK: helpers

  private func clearTranscriber() {
    streamTranscriber = nil
    emittedConfirmedCount = 0
  }

  private func deactivateAudioSession() {
    try? AVAudioSession.sharedInstance().setActive(
      false,
      options: .notifyOthersOnDeactivation
    )
  }
}

// MARK: - EmittedCountBox

/// Reference-type counter so the `stateChangeCallback` closure can mutate
/// the emitted-segment count without capturing the actor.
private final class EmittedCountBox: @unchecked Sendable {
  private(set) var count: Int = 0
  func increment() { count += 1 }
}

// MARK: - Errors

private enum WhisperKitModuleError: Error {
  case notInitialized
  case alreadyRunning
  case audioSessionError(Error)
  /// Callers passed a model name not in `knownModelNames`.
  case unknownModel(String)
}
