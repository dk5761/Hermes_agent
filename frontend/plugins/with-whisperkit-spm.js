/**
 * with-whisperkit-spm.js — Expo config plugin
 *
 * Wires WhisperKit (Argmax) Swift Package into the ExpoWhisperKit Pod target
 * during `expo prebuild`. WhisperKit ships only via SwiftPM, so CocoaPods
 * cannot list it as a Pod dependency. This plugin:
 *
 *   1. Injects a `post_install` block into the generated Podfile.
 *   2. The block runs after `pod install` and registers WhisperKit as an
 *      XCRemoteSwiftPackageReference on the Pods project, then links it
 *      into the ExpoWhisperKit Pod target's frameworks build phase.
 *
 * Idempotent at every level:
 *   - Plugin: skips injection if marker comment already present in Podfile.
 *   - Hook:   skips work if the package reference / product dep already exist.
 *
 * Why a plugin (not a manual Podfile edit): every `expo prebuild` regenerates
 * the Podfile from scratch. A plugin re-injects on each run.
 */

const { withDangerousMod } = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const MARKER = "# whisperkit-spm-hook:v2";

const HOOK = `
    ${MARKER}
    # Wire WhisperKit SPM dependency into the ExpoWhisperKit Pod target.
    # Injected by plugins/with-whisperkit-spm.js — survives expo prebuild.
    pods_project = installer.pods_project
    whisper_target = pods_project.targets.find { |t| t.name == 'ExpoWhisperKit' }
    if whisper_target
      pkg_ref = pods_project.root_object.package_references.find do |r|
        r.respond_to?(:repositoryURL) && r.repositoryURL == 'https://github.com/argmaxinc/argmax-oss-swift'
      end
      unless pkg_ref
        pkg_ref = pods_project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
        pkg_ref.repositoryURL = 'https://github.com/argmaxinc/argmax-oss-swift'
        pkg_ref.requirement = { 'kind' => 'exactVersion', 'version' => '1.0.0' }
        pods_project.root_object.package_references << pkg_ref
      end
      product = whisper_target.package_product_dependencies.find { |d| d.product_name == 'WhisperKit' }
      unless product
        product = pods_project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
        product.package = pkg_ref
        product.product_name = 'WhisperKit'
        whisper_target.package_product_dependencies << product
      end

      already_linked = whisper_target.frameworks_build_phase.files.any? do |file|
        file.respond_to?(:product_ref) &&
          file.product_ref &&
          file.product_ref.respond_to?(:product_name) &&
          file.product_ref.product_name == 'WhisperKit'
      end
      unless already_linked
        build_file = pods_project.new(Xcodeproj::Project::Object::PBXBuildFile)
        build_file.product_ref = product
        whisper_target.frameworks_build_phase.files << build_file
      end

      # Xcode does not automatically add the SwiftPM product module location to
      # this CocoaPods target's Swift import search paths. The package emits
      # WhisperKit.swiftmodule into the root products directory, so expose that
      # directory to the ExpoWhisperKit compiler invocation.
      whisper_target.build_configurations.each do |config|
        settings = config.build_settings
        include_paths = Array(settings['SWIFT_INCLUDE_PATHS'] || ['$(inherited)'])
        module_path = '$(PODS_CONFIGURATION_BUILD_DIR)'
        include_paths << module_path unless include_paths.include?(module_path)
        settings['SWIFT_INCLUDE_PATHS'] = include_paths
      end
      pods_project.save
    end
`;

module.exports = function withWhisperKitSPM(config) {
  return withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const podfilePath = path.join(
        cfg.modRequest.platformProjectRoot,
        "Podfile",
      );
      let contents = fs.readFileSync(podfilePath, "utf8");

      if (contents.includes(MARKER)) return cfg;

      // Insert immediately after the existing react_native_post_install(...)
      // closing paren — it's the cleanest anchor and matches the generator's
      // current Podfile shape. If RN ever changes the call signature, the
      // regex still matches the closing `)` of the call.
      const updated = contents.replace(
        /(react_native_post_install\([\s\S]*?\)\s*\n)/,
        `$1${HOOK}\n`,
      );

      if (updated === contents) {
        throw new Error(
          "[with-whisperkit-spm] could not find react_native_post_install anchor in Podfile",
        );
      }

      fs.writeFileSync(podfilePath, updated);
      return cfg;
    },
  ]);
};
