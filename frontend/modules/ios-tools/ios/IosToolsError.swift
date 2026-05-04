import ExpoModulesCore
import Foundation

// MARK: - Typed exceptions for ios-tools
//
// Uses expo-modules-core's `Exception` class hierarchy (the modern pattern).
// The `code` property on each exception maps to `error.code` in JS.
//
// Stable codes:
//   permissionDenied  — caller has not been granted the required iOS permission
//   notFound          — a requested calendar / list / event ID does not exist
//   unsupported       — the operation cannot run on this platform/OS version
//   unknown           — any other unexpected failure

final class PermissionDeniedException: GenericException<String> {
  override var reason: String { param }
  override var code: String { "permissionDenied" }
}

final class NotFoundException: GenericException<String> {
  override var reason: String { param }
  override var code: String { "notFound" }
}

final class UnsupportedException: GenericException<String> {
  override var reason: String { param }
  override var code: String { "unsupported" }
}

final class UnknownIosToolsException: GenericException<String> {
  override var reason: String { param }
  override var code: String { "unknown" }
}

// MARK: - Convenience factory

/// Wraps the old IosToolsError enum-style call sites so we can migrate
/// them incrementally. Call sites use `IosToolsError.permissionDenied(msg)` etc.
enum IosToolsError {
  static func permissionDenied(_ message: String) -> PermissionDeniedException {
    PermissionDeniedException(message)
  }

  static func notFound(_ message: String) -> NotFoundException {
    NotFoundException(message)
  }

  static func unsupported(_ message: String) -> UnsupportedException {
    UnsupportedException(message)
  }

  static func unknown(_ message: String) -> UnknownIosToolsException {
    UnknownIosToolsException(message)
  }
}
