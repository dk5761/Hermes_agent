import EventKit
import ExpoModulesCore
import Foundation
import UserNotifications

// MARK: - Permission status string

/// Stable string values returned to JS.
enum PermissionStatus: String {
  case granted = "granted"
  case denied = "denied"
  case notDetermined = "not_determined"
  case restricted = "restricted"
}

// MARK: - EKAuthorizationStatus → PermissionStatus

extension EKAuthorizationStatus {
  var permissionStatus: PermissionStatus {
    switch self {
    case .notDetermined:
      return .notDetermined
    case .restricted:
      return .restricted
    case .denied:
      return .denied
    case .authorized:
      // .authorized is the same raw value as .fullAccess (iOS 17+).
      // Both map to .granted since we requested full access.
      return .granted
    @unknown default:
      // Handles .writeOnly (iOS 17+) and any future cases.
      // We treat partial / unknown access as denied since we need full access.
      return .denied
    }
  }
}

// MARK: - UNAuthorizationStatus → PermissionStatus

extension UNAuthorizationStatus {
  var permissionStatus: PermissionStatus {
    switch self {
    case .authorized, .provisional, .ephemeral:
      return .granted
    case .denied:
      return .denied
    case .notDetermined:
      return .notDetermined
    @unknown default:
      return .notDetermined
    }
  }
}

// MARK: - Permission helpers used by IosToolsModule

/// Request + get Calendar permission.
func requestCalendarPermission() async throws -> String {
  let status = try await EventStoreManager.shared.requestCalendarAccess()
  return status.permissionStatus.rawValue
}

/// Get current Calendar permission status (no prompt).
func getCalendarPermissionStatus() -> String {
  EventStoreManager.shared.calendarStatus().permissionStatus.rawValue
}

/// Request + get Reminders permission.
func requestRemindersPermission() async throws -> String {
  let status = try await EventStoreManager.shared.requestRemindersAccess()
  return status.permissionStatus.rawValue
}

/// Get current Reminders permission status (no prompt).
func getRemindersPermissionStatus() -> String {
  EventStoreManager.shared.remindersStatus().permissionStatus.rawValue
}

/// Request + get Notifications permission.
func requestNotificationsPermission() async -> String {
  let center = UNUserNotificationCenter.current()
  // Check current setting first to avoid re-prompting.
  let current = await center.notificationSettings()
  switch current.authorizationStatus {
  case .authorized, .provisional, .ephemeral:
    return PermissionStatus.granted.rawValue
  case .denied:
    return PermissionStatus.denied.rawValue
  case .notDetermined:
    break  // fall through to request
  @unknown default:
    return PermissionStatus.notDetermined.rawValue
  }
  // notDetermined — ask.
  do {
    let granted = try await center.requestAuthorization(options: [
      .alert, .sound, .badge,
    ])
    return granted
      ? PermissionStatus.granted.rawValue : PermissionStatus.denied.rawValue
  } catch {
    return PermissionStatus.denied.rawValue
  }
}
