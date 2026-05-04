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

    // -------------------------------------------------------------------------
    // Calendar writes
    // -------------------------------------------------------------------------

    /// addEvent({ title, startMs, endMs, calendarId?, notes?, allDay? })
    AsyncFunction("addEvent") {
      (args: [String: Any]) throws -> [String: Any] in
      guard let title = args["title"] as? String, !title.isEmpty else {
        throw IosToolsError.unknown("addEvent: title is required")
      }
      guard let startMs = (args["startMs"] as? NSNumber)?.doubleValue else {
        throw IosToolsError.unknown("addEvent: startMs is required")
      }
      guard let endMs = (args["endMs"] as? NSNumber)?.doubleValue else {
        throw IosToolsError.unknown("addEvent: endMs is required")
      }
      let calendarId = args["calendarId"] as? String
      let notes = args["notes"] as? String
      let allDay = (args["allDay"] as? Bool) ?? false
      return try addEvent(
        title: title, startMs: startMs, endMs: endMs,
        calendarId: calendarId, notes: notes, allDay: allDay)
    }

    /// deleteEvent({ id })
    AsyncFunction("deleteEvent") {
      (args: [String: Any]) throws -> [String: Any] in
      guard let id = args["id"] as? String, !id.isEmpty else {
        throw IosToolsError.unknown("deleteEvent: id is required")
      }
      return try deleteEvent(id: id)
    }

    // -------------------------------------------------------------------------
    // Reminders writes
    // -------------------------------------------------------------------------

    /// addReminder({ title, dueDateMs?, listId?, notes? })
    AsyncFunction("addReminder") {
      (args: [String: Any]) throws -> [String: Any] in
      guard let title = args["title"] as? String, !title.isEmpty else {
        throw IosToolsError.unknown("addReminder: title is required")
      }
      let dueDateMs = (args["dueDateMs"] as? NSNumber)?.doubleValue
      let listId = args["listId"] as? String
      let notes = args["notes"] as? String
      return try addReminder(
        title: title, dueDateMs: dueDateMs, listId: listId, notes: notes)
    }

    /// completeReminder({ id })
    AsyncFunction("completeReminder") {
      (args: [String: Any]) throws -> [String: Any] in
      guard let id = args["id"] as? String, !id.isEmpty else {
        throw IosToolsError.unknown("completeReminder: id is required")
      }
      return try completeReminder(id: id)
    }

    // -------------------------------------------------------------------------
    // Notifications write
    // -------------------------------------------------------------------------

    /// sendLocalNotification({ title, body, fireAtMs? })
    AsyncFunction("sendLocalNotification") {
      (args: [String: Any]) async throws -> [String: Any] in
      guard let title = args["title"] as? String, !title.isEmpty else {
        throw IosToolsError.unknown("sendLocalNotification: title is required")
      }
      guard let body = args["body"] as? String else {
        throw IosToolsError.unknown("sendLocalNotification: body is required")
      }
      let fireAtMs = (args["fireAtMs"] as? NSNumber)?.doubleValue
      return try await sendLocalNotification(
        title: title, body: body, fireAtMs: fireAtMs)
    }

    // -------------------------------------------------------------------------
    // Shortcuts launcher
    // -------------------------------------------------------------------------

    /// runShortcut({ name, input? })
    AsyncFunction("runShortcut") {
      (args: [String: Any]) async throws -> [String: Any] in
      guard let name = args["name"] as? String, !name.isEmpty else {
        throw IosToolsError.unknown("runShortcut: name is required")
      }
      let input = args["input"] as? String
      return try await runShortcut(name: name, input: input)
    }
  }
}
