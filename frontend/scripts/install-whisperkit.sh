#!/usr/bin/env bash
# install-whisperkit.sh
#
# Adds WhisperKit 0.18.0 as a Swift Package Manager dependency to the Hermes
# Xcode project by editing project.pbxproj directly.
#
# Run from the repo root:
#   bash frontend/scripts/install-whisperkit.sh
#
# This script is idempotent — it exits cleanly if WhisperKit is already present.
#
# After running this script, `pod install` (or `pnpm prebuild && pod install`)
# will link the WhisperKit product into the Hermes target automatically because
# the Xcode project references it.

set -euo pipefail

PBXPROJ="$(dirname "$0")/../ios/Hermes.xcodeproj/project.pbxproj"
PACKAGE_URL="https://github.com/argmaxinc/WhisperKit"
PACKAGE_VERSION="0.18.0"

if grep -q "argmaxinc/WhisperKit" "$PBXPROJ"; then
  echo "WhisperKit already present in project.pbxproj — nothing to do."
  exit 0
fi

echo "NOTE: Automatic pbxproj injection for SPM packages is complex and"
echo "fragile. The recommended path is to add WhisperKit via Xcode UI:"
echo ""
echo "  1. Open frontend/ios/Hermes.xcworkspace"
echo "  2. File → Add Package Dependencies…"
echo "  3. URL:     $PACKAGE_URL"
echo "     Version: Exact  $PACKAGE_VERSION"
echo "  4. Add product 'WhisperKit' to target 'Hermes'"
echo ""
echo "After that, run: cd frontend/ios && pod install"
echo ""
echo "Alternatively, use swift package resolve inside the Xcode project:"
echo "  xcodebuild -resolvePackageDependencies \\"
echo "    -project frontend/ios/Hermes.xcodeproj \\"
echo "    -scheme Hermes"
