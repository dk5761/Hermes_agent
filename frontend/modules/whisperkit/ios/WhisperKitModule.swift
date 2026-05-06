import AVFoundation
import ExpoModulesCore
import Foundation
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
  private var loadedModelName: String?
  private var streamTranscriber: AudioStreamTranscriber?

  // Tracks how many confirmed segments have been emitted across this stream.
  private var emittedConfirmedCount: Int = 0
  private var nextSegmentId: Int = 0

  // MARK: Cache directory

  /// The directory under which WhisperKit (via HuggingFace Hub) stores downloaded
  /// model variants.  Path: `<Documents>/huggingface/models/argmaxinc/whisperkit-coreml/`
  ///
  /// This mirrors ArgmaxCore's default `HubApi.downloadBase` when
  /// `downloadBase` is nil.
  nonisolated static func modelCacheBase() -> URL? {
    guard
      let documentsDir = FileManager.default.urls(
        for: .documentDirectory,
        in: .userDomainMask
      ).first
    else { return nil }
    return documentsDir
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
    if whisperKit != nil, loadedModelName == modelName {
      onProgress(1.0)
      return
    }
    if streamTranscriber != nil, loadedModelName != modelName {
      throw WhisperKitModuleError.alreadyRunning
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

    NSLog("[whisperkit] download+load \(modelName) (markerExists=\(markerExists))")
    onProgress(0.0)

    do {
      let downloadedDir: URL
      if markerExists, let cachedDir = WhisperKitBackend.modelDir(for: modelName) {
        downloadedDir = cachedDir
      } else {
        downloadedDir = try await WhisperKitBackend.downloadModel(
          modelName: modelName,
          onProgress: onProgress
        )
      }

      try await loadDownloadedModel(downloadedDir, modelName: modelName)

      NSLog("[whisperkit] download+load complete: \(modelName) at \(downloadedDir.path)")
      onProgress(1.0)
    } catch {
      if markerExists {
        NSLog("[whisperkit] cached model failed to load; retrying clean download: \(String(describing: error))")
        WhisperKitBackend.wipePartialDownload(for: modelName)
        let downloadedDir = try await WhisperKitBackend.downloadModel(
          modelName: modelName,
          onProgress: onProgress
        )
        try await loadDownloadedModel(downloadedDir, modelName: modelName)
        NSLog("[whisperkit] clean retry complete: \(modelName) at \(downloadedDir.path)")
        onProgress(1.0)
        return
      }
      NSLog("[whisperkit] download+load failed: \(String(describing: error))")
      throw error
    }
  }

  private func loadDownloadedModel(_ modelDir: URL, modelName: String) async throws {
    let config = WhisperKitConfig(
      modelFolder: modelDir.path,
      verbose: false,
      logLevel: .none,
      prewarm: false,
      load: true,
      download: false
    )
    let kit = try await WhisperKit(config)
    whisperKit = kit
    loadedModelName = modelName
    emittedConfirmedCount = 0
    nextSegmentId = 0

    // Write completion marker so future cold-starts skip the wipe.
    let marker = modelDir.appendingPathComponent(".download-complete")
    FileManager.default.createFile(atPath: marker.path, contents: nil)
  }

  nonisolated static func downloadModel(
    modelName: String,
    onProgress: @escaping @Sendable (Double) -> Void
  ) async throws -> URL {
    guard let repoDir = modelCacheBase() else {
      throw WhisperKitModuleError.cacheDirectoryUnavailable
    }

    let modelDir = repoDir.appendingPathComponent(modelName, isDirectory: true)
    try FileManager.default.createDirectory(
      at: modelDir,
      withIntermediateDirectories: true
    )

    let files = try await fetchModelFiles(modelName: modelName)
    let totalBytes = max(files.reduce(0) { $0 + $1.size }, 1)
    var completedBytes = 0

    for file in files {
      let relativePath = String(file.path.dropFirst("\(modelName)/".count))
      let destination = modelDir.appendingPathComponent(relativePath)
      try FileManager.default.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )

      let source = URL(string: "https://huggingface.co")!
        .appendingPathComponent("argmaxinc/whisperkit-coreml")
        .appendingPathComponent("resolve")
        .appendingPathComponent("main")
        .appendingPathComponent(file.path)

      let (temporaryURL, response) = try await URLSession.shared.download(from: source)
      if let http = response as? HTTPURLResponse,
         !(200...299).contains(http.statusCode) {
        throw WhisperKitModuleError.downloadFailed(file.path, http.statusCode)
      }

      if FileManager.default.fileExists(atPath: destination.path) {
        try FileManager.default.removeItem(at: destination)
      }
      try FileManager.default.moveItem(at: temporaryURL, to: destination)

      completedBytes += file.size
      let fraction = max(0.0, min(Double(completedBytes) / Double(totalBytes), 1.0))
      NSLog("[whisperkit] progress: \(Int(fraction * 100))% \(relativePath)")
      onProgress(fraction)
    }

    return modelDir
  }

  private struct HuggingFaceTreeEntry: Decodable {
    let type: String
    let path: String
    let size: Int
  }

  private nonisolated static func fetchModelFiles(modelName: String) async throws -> [HuggingFaceTreeEntry] {
    let url = URL(string: "https://huggingface.co")!
      .appendingPathComponent("api")
      .appendingPathComponent("models")
      .appendingPathComponent("argmaxinc/whisperkit-coreml")
      .appendingPathComponent("tree")
      .appendingPathComponent("main")
      .appendingPathComponent(modelName)
      .appending(queryItems: [URLQueryItem(name: "recursive", value: "true")])

    let (data, response) = try await URLSession.shared.data(from: url)
    if let http = response as? HTTPURLResponse,
       !(200...299).contains(http.statusCode) {
      throw WhisperKitModuleError.modelTreeUnavailable(modelName, http.statusCode)
    }

    let entries = try JSONDecoder().decode([HuggingFaceTreeEntry].self, from: data)
    let files = entries
      .filter { $0.type == "file" && $0.path.hasPrefix("\(modelName)/") }
      .sorted { $0.path < $1.path }

    if files.isEmpty {
      throw WhisperKitModuleError.emptyModelTree(modelName)
    }
    return files
  }

  /// Returns true if the on-disk completion marker exists for this model.
  nonisolated static func markerExistsForModel(_ modelName: String) -> Bool {
    guard let modelDir = modelDir(for: modelName) else { return false }
    let marker = modelDir.appendingPathComponent(".download-complete")
    return FileManager.default.fileExists(atPath: marker.path)
  }

  /// Returns the expected HuggingFace snapshot folder for the public model name.
  nonisolated static func modelDir(for modelName: String) -> URL? {
    guard let cacheBase = modelCacheBase() else { return nil }
    return cacheBase.appendingPathComponent(modelName, isDirectory: true)
  }

  /// Removes the specific model variant directory plus HuggingFace's per-file
  /// metadata for that variant. Both trees must be cleared together because
  /// HubApi stores downloaded files and metadata as siblings under the repo.
  ///
  /// - Parameter modelName: The WhisperKit model variant folder name, e.g.
  ///   `"openai_whisper-large-v3-v20240930"`.
  nonisolated static func wipePartialDownload(for modelName: String) {
    guard let repoDir = modelCacheBase() else { return }

    let modelDir = repoDir.appendingPathComponent(modelName, isDirectory: true)
    if FileManager.default.fileExists(atPath: modelDir.path) {
      NSLog("[whisperkit] wiping partial download: \(modelDir.path)")
      try? FileManager.default.removeItem(at: modelDir)
    }

    let metadataDir = repoDir
      .appendingPathComponent(".cache/huggingface/download", isDirectory: true)
      .appendingPathComponent(modelName, isDirectory: true)
    if FileManager.default.fileExists(atPath: metadataDir.path) {
      NSLog("[whisperkit] wiping partial metadata: \(metadataDir.path)")
      try? FileManager.default.removeItem(at: metadataDir)
    }
  }

  // MARK: load

  /// Load a model that is already on disk into memory.
  /// Now a no-op if `ensureModel` already loaded it (the all-in-one path).
  func load(modelName: String) async throws {
    if whisperKit != nil, loadedModelName == modelName { return }
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
    loadedModelName = nil
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
  case cacheDirectoryUnavailable
  case modelTreeUnavailable(String, Int)
  case emptyModelTree(String)
  case downloadFailed(String, Int)
  /// Callers passed a model name not in `knownModelNames`.
  case unknownModel(String)
}
