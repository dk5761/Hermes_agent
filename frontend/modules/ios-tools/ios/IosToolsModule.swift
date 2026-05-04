import EventKit
import ExpoModulesCore
import Foundation
import UserNotifications

// MARK: - Module definition
//
// Expo Modules API module. All async methods use Swift concurrency (async/await).
// The framework bridges them to JS Promises automatically.
//
// Deployment target: iOS 16.2 (matching app.json).
// iOS 17+ APIs (requestFullAccessToEvents / requestFullAccessToReminders)
// are gated behind `#available(iOS 17, *)` in EventStoreManager.swift.
public class IosToolsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("IosTools")

    // -------------------------------------------------------------------------
    // Permissions
    // -------------------------------------------------------------------------

    AsyncFunction("requestCalendarPermission") { () async throws -> String in
      try await requestCalendarPermission()
    }

    AsyncFunction("getCalendarPermissionStatus") { () -> String in
      getCalendarPermissionStatus()
    }

    AsyncFunction("requestRemindersPermission") { () async throws -> String in
      try await requestRemindersPermission()
    }

    AsyncFunction("getRemindersPermissionStatus") { () -> String in
      getRemindersPermissionStatus()
    }

    AsyncFunction("requestNotificationsPermission") { () async -> String in
      await requestNotificationsPermission()
    }

    // -------------------------------------------------------------------------
    // Calendar reads
    // -------------------------------------------------------------------------

    AsyncFunction("listCalendars") { () throws -> [[String: Any]] in
      try listCalendars()
    }

    /// listEvents({ startMs, endMs, calendarIds? })
    AsyncFunction("listEvents") {
      (args: [String: Any]) throws -> [[String: Any]] in
      guard let startMs = (args["startMs"] as? NSNumber)?.doubleValue else {
        throw IosToolsError.unknown("listEvents: startMs is required")
      }
      guard let endMs = (args["endMs"] as? NSNumber)?.doubleValue else {
        throw IosToolsError.unknown("listEvents: endMs is required")
      }
      let calendarIds = args["calendarIds"] as? [String]
      return try listEvents(
        startMs: startMs, endMs: endMs, calendarIds: calendarIds)
    }

    // -------------------------------------------------------------------------
    // Reminders reads
    // -------------------------------------------------------------------------

    AsyncFunction("listReminderLists") { () throws -> [[String: Any]] in
      try listReminderLists()
    }

    /// listReminders({ filter?, listIds? })
    AsyncFunction("listReminders") {
      (args: [String: Any]) async throws -> [[String: Any]] in
      let filter = args["filter"] as? String
      let listIds = args["listIds"] as? [String]
      return try await listReminders(filter: filter, listIds: listIds)
    }
  }
}
