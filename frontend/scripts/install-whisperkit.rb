#!/usr/bin/env ruby
# install-whisperkit.rb
#
# Adds WhisperKit Swift Package as a dependency on the Hermes target.
# Idempotent — re-running is safe; exits cleanly if already present.
#
# Why Ruby: WhisperKit ships only as a Swift Package (no CocoaPod). Adding
# an SPM package requires touching multiple sections of project.pbxproj
# (XCRemoteSwiftPackageReference, XCSwiftPackageProductDependency, the
# project's packageReferences, and the target's frameworks build phase).
# The CocoaPods-bundled `xcodeproj` gem handles this correctly.
#
# Usage:
#   ruby frontend/scripts/install-whisperkit.rb

require "xcodeproj"

REPO     = "https://github.com/argmaxinc/argmax-oss-swift"
OLD_REPO = "https://github.com/argmaxinc/WhisperKit"
VER   = "1.0.0"
PRODUCT = "WhisperKit"
TARGET_NAME = "Hermes"

project_path = File.expand_path("../ios/Hermes.xcodeproj", __dir__)
project = Xcodeproj::Project.open(project_path)

target = project.targets.find { |t| t.name == TARGET_NAME }
abort("Target #{TARGET_NAME} not found") unless target

# Remove any stale reference pointing at the old repo URL (argmaxinc/WhisperKit).
# Without this, Xcode would have two conflicting package entries for the same product.
old_pkg = project.root_object.package_references.find do |ref|
  ref.respond_to?(:repositoryURL) && ref.repositoryURL == OLD_REPO
end
if old_pkg
  # Remove from every target's product dependencies
  project.targets.each do |t|
    t.package_product_dependencies.to_a.each do |dep|
      if dep.package == old_pkg
        t.package_product_dependencies.delete(dep)
        puts "[wk] removed product dependency on old repo from target #{t.name}"
      end
    end
  end
  project.root_object.package_references.delete(old_pkg)
  puts "[wk] removed stale package reference: #{OLD_REPO}"
end

existing_pkg = project.root_object.package_references.find do |ref|
  ref.respond_to?(:repositoryURL) && ref.repositoryURL == REPO
end

if existing_pkg
  puts "[wk] package reference already present"
  pkg_ref = existing_pkg
else
  pkg_ref = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
  pkg_ref.repositoryURL = REPO
  pkg_ref.requirement = { "kind" => "exactVersion", "version" => VER }
  project.root_object.package_references << pkg_ref
  puts "[wk] added remote package reference: #{REPO}@#{VER}"
end

already_linked = target.package_product_dependencies.any? do |d|
  d.product_name == PRODUCT
end

if already_linked
  puts "[wk] target #{TARGET_NAME} already links #{PRODUCT}"
else
  product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
  product.package = pkg_ref
  product.product_name = PRODUCT
  target.package_product_dependencies << product

  build_phase = target.frameworks_build_phase
  already_in_phase = build_phase.files.any? do |bf|
    bf.product_ref.is_a?(Xcodeproj::Project::Object::XCSwiftPackageProductDependency) &&
      bf.product_ref.product_name == PRODUCT
  end
  unless already_in_phase
    build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
    build_file.product_ref = product
    build_phase.files << build_file
  end

  puts "[wk] linked #{PRODUCT} into #{TARGET_NAME}.frameworks"
end

project.save
puts "[wk] saved project — now run: cd frontend/ios && pod install"
