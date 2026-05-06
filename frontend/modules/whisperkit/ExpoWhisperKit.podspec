Pod::Spec.new do |s|
  s.name           = 'ExpoWhisperKit'
  s.version        = '1.0.0'
  s.summary        = 'Expo native module wrapping Argmax WhisperKit for on-device streaming Whisper transcription'
  s.description    = <<-DESC
    iOS-only Expo Module that bridges WhisperKit (argmaxinc/argmax-oss-swift v1.0.0)
    to JavaScript. Exposes init / start / stop / release methods plus
    onPartial / onConfirmed / onError / onModelDownloadProgress events.
  DESC
  s.author         = { 'Hermes' => 'noreply@hermesapp.local' }
  s.homepage       = 'https://github.com/hermesapp/hermes-mobile'
  s.license        = { :type => 'MIT' }
  # WhisperKit requires iOS 16+ for full streaming support.
  s.platforms      = { :ios => '16.0' }
  s.source         = { :git => 'https://github.com/hermesapp/hermes-mobile.git', :tag => "v#{s.version}" }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.source_files = 'ios/**/*.swift'

  # ExpoModulesCore is always present in an Expo managed project.
  s.dependency 'ExpoModulesCore'

  # ---------------------------------------------------------------------------
  # WhisperKit ships via Swift Package Manager, not CocoaPods. It cannot be
  # listed here as a Pod dependency. Instead the consumer project (Hermes.xcodeproj)
  # must have WhisperKit added as an SPM package.
  #
  # NOTE: As of v1.0.0, WhisperKit moved to a new GitHub repo:
  #   https://github.com/argmaxinc/argmax-oss-swift
  # The Swift import remains `import WhisperKit` (product name unchanged).
  #
  # Automated addition: run  ruby scripts/install-whisperkit.rb  from the repo root.
  # Manual addition:
  #   1. Open ios/Hermes.xcworkspace in Xcode
  #   2. File → Add Package Dependencies…
  #   3. URL: https://github.com/argmaxinc/argmax-oss-swift
  #      Version rule: Exact  1.0.0
  #      Add product "WhisperKit" to target "Hermes"
  # ---------------------------------------------------------------------------
end
