import ExpoModulesCore
import Foundation
import UIKit

// MARK: - Shortcuts URL-scheme launcher

/// Launches an Apple Shortcut by name via the `shortcuts://run-shortcut` URL scheme.
///
/// NOTE: This opens the Shortcuts app (the user's app is backgrounded). There
/// is no way to verify from outside the Shortcuts app that the shortcut
/// actually ran to completion. `ok: true` means the URL was successfully
/// handed off to UIApplication, not that the shortcut finished.
///
/// - Parameters:
///   - name: The exact name of the Shortcut as it appears in the Shortcuts app.
///   - input: Optional string input passed to the shortcut.
/// - Returns: A dict `{ "ok": true }`.
func runShortcut(name: String, input: String?) async throws -> [String: Any] {
  // URL-encode name and optional input.
  guard
    let encodedName = name.addingPercentEncoding(
      withAllowedCharacters: .urlQueryAllowed)
  else {
    throw IosToolsError.unknown(
      "runShortcut: could not percent-encode shortcut name '\(name)'.")
  }

  var urlString = "shortcuts://run-shortcut?name=\(encodedName)"

  if let input = input, !input.isEmpty {
    guard
      let encodedInput = input.addingPercentEncoding(
        withAllowedCharacters: .urlQueryAllowed)
    else {
      throw IosToolsError.unknown(
        "runShortcut: could not percent-encode shortcut input.")
    }
    urlString += "&input=\(encodedInput)"
  }

  guard let url = URL(string: urlString) else {
    throw IosToolsError.unknown(
      "runShortcut: constructed URL is invalid: '\(urlString)'.")
  }

  // UIApplication.shared.open must be called on the main actor.
  let opened = await MainActor.run {
    UIApplication.shared.canOpenURL(url)
  }

  guard opened else {
    throw IosToolsError.unsupported(
      "runShortcut: the shortcuts:// URL scheme is not available on this device. "
        + "Ensure the Shortcuts app is installed.")
  }

  await MainActor.run {
    UIApplication.shared.open(url)
  }

  return ["ok": true]
}
