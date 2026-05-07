/**
 * with-whisperkit-spm.js — Expo config plugin
 *
 * Wires WhisperKit (Argmax) Swift Package into the ExpoWhisperKit Pod target
 * during `expo prebuild`. WhisperKit ships only via SwiftPM, so CocoaPods
 * cannot list it as a Pod dependency. This plugin:
 *
 *   1. Injects a `post_install` block into the generated Podfile.
 *   2. The plugin registers WhisperKit as an XCRemoteSwiftPackageReference on
 *      the app project, then links it into the Hermes target's frameworks phase.
 *   3. The block makes the app scheme explicitly build the CocoaPods aggregate
 *      target. Without that, Xcode can compile AppDelegate before Expo exists.
 *
 * Idempotent at every level:
 *   - Plugin: skips injection if marker comment already present in Podfile.
 *   - Hook:   skips work if the package reference / product dep already exist.
 *
 * Why a plugin (not a manual Podfile edit): every `expo prebuild` regenerates
 * the Podfile from scratch. A plugin re-injects on each run.
 */

const { withDangerousMod } = require("@expo/config-plugins");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MARKER = "# whisperkit-spm-hook:v2";

const HOOK = `
    ${MARKER}
    # Wire WhisperKit build settings into the ExpoWhisperKit Pod target.
    # Injected by plugins/with-whisperkit-spm.js — survives expo prebuild.
    pods_project = installer.pods_project
    whisper_target = pods_project.targets.find { |t| t.name == 'ExpoWhisperKit' }
    if whisper_target
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

    # Xcode 26 does not infer the CocoaPods aggregate target from the app's
    # linked libPods-Hermes.a in this generated workspace. Make the scheme
    # explicit so Expo pods are compiled before AppDelegate imports Expo.
    require 'rexml/document'

    pods_aggregate_target = pods_project.targets.find { |t| t.name == 'Pods-Hermes' }
    scheme_path = File.join(__dir__, 'Hermes.xcodeproj', 'xcshareddata', 'xcschemes', 'Hermes.xcscheme')

    if pods_aggregate_target && File.exist?(scheme_path)
      scheme = REXML::Document.new(File.read(scheme_path))
      build_action_entries = REXML::XPath.first(scheme, '/Scheme/BuildAction/BuildActionEntries')

      unless REXML::XPath.first(scheme, "//*[@BlueprintIdentifier='#{pods_aggregate_target.uuid}']")
        entry = REXML::Element.new('BuildActionEntry')
        entry.add_attributes({
          'buildForTesting' => 'YES',
          'buildForRunning' => 'YES',
          'buildForProfiling' => 'YES',
          'buildForArchiving' => 'YES',
          'buildForAnalyzing' => 'YES',
        })

        reference = REXML::Element.new('BuildableReference')
        reference.add_attributes({
          'BuildableIdentifier' => 'primary',
          'BlueprintIdentifier' => pods_aggregate_target.uuid,
          'BuildableName' => 'Pods_Hermes.framework',
          'BlueprintName' => 'Pods-Hermes',
          'ReferencedContainer' => 'container:Pods/Pods.xcodeproj',
        })

        entry.add_element(reference)
        build_action_entries.insert_before(build_action_entries.elements[1], entry)

        formatter = REXML::Formatters::Pretty.new(3)
        formatter.compact = true
        output = +''
        formatter.write(scheme, output)
        File.write(scheme_path, output)
      end
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

      if (contents.includes(MARKER)) {
        execFileSync("ruby", [path.join(cfg.modRequest.projectRoot, "scripts/install-whisperkit.rb")], {
          cwd: cfg.modRequest.projectRoot,
          stdio: "inherit",
        });
        return cfg;
      }

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
      execFileSync("ruby", [path.join(cfg.modRequest.projectRoot, "scripts/install-whisperkit.rb")], {
        cwd: cfg.modRequest.projectRoot,
        stdio: "inherit",
      });
      return cfg;
    },
  ]);
};
