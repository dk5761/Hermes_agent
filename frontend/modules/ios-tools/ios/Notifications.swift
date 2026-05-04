import ExpoModulesCore
import Foundation
import UserNotifications

// MARK: - Notification read helpers (Phase 1: permission only)
//
// Phase 1 exposes permission request/query only. Sending notifications
// is added in Phase 2 as part of the write methods.

/// Returns the current notification authorisation status without prompting.
func getNotificationsPermissionStatus() async -> String {
  let settings = await UNUserNotificationCenter.current()
    .notificationSettings()
  return settings.authorizationStatus.permissionStatus.rawValue
}
