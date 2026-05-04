import ExpoModulesCore
import Foundation
import UserNotifications

// MARK: - Notification helpers

// Phase 1: permission query (read)
// Phase 2: sendLocalNotification (write)

/// Returns the current notification authorisation status without prompting.
func getNotificationsPermissionStatus() async -> String {
  let settings = await UNUserNotificationCenter.current()
    .notificationSettings()
  return settings.authorizationStatus.permissionStatus.rawValue
}

/// Schedules (or immediately delivers) a local notification.
///
/// - Parameters:
///   - title: Notification title (required).
///   - body: Notification body text (required).
///   - fireAtMs: Optional future epoch-millisecond timestamp. If omitted or in
///     the past, the notification is delivered immediately (no trigger).
/// - Returns: A dict `{ "id": String }` with the notification request identifier.
func sendLocalNotification(
  title: String,
  body: String,
  fireAtMs: Double?
) async throws -> [String: Any] {
  let center = UNUserNotificationCenter.current()

  // Check permission — do not prompt here; caller should have called
  // requestNotificationsPermission() first.
  let settings = await center.notificationSettings()
  guard settings.authorizationStatus == .authorized
    || settings.authorizationStatus == .provisional
    || settings.authorizationStatus == .ephemeral
  else {
    throw IosToolsError.permissionDenied(
      "sendLocalNotification: notifications not authorized. "
        + "Call requestNotificationsPermission first."
    )
  }

  let content = UNMutableNotificationContent()
  content.title = title
  content.body = body
  content.sound = .default

  // Build trigger if fireAtMs is a future timestamp.
  var trigger: UNNotificationTrigger? = nil
  if let ms = fireAtMs {
    let fireDate = Date(timeIntervalSince1970: ms / 1000.0)
    let interval = fireDate.timeIntervalSinceNow
    if interval > 0 {
      trigger = UNTimeIntervalNotificationTrigger(
        timeInterval: interval, repeats: false)
    }
    // If the date is in the past, fall through with trigger = nil (immediate).
  }

  let identifier = UUID().uuidString
  let request = UNNotificationRequest(
    identifier: identifier,
    content: content,
    trigger: trigger
  )

  try await center.add(request)

  return ["id": identifier]
}
