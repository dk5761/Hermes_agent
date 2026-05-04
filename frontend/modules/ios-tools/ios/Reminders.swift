import EventKit
import ExpoModulesCore
import Foundation

// MARK: - Reminders read methods

/// Returns all reminder lists (EKCalendar with type reminder).
/// Requires Reminders access to have been granted (caller must check).
func listReminderLists() throws -> [[String: Any]] {
  guard
    EventStoreManager.shared.remindersStatus().permissionStatus == .granted
  else {
    throw IosToolsError.permissionDenied(
      "Reminders permission not granted. Call requestRemindersPermission first."
    )
  }
  let store = EventStoreManager.shared.store
  let defaultList = store.defaultCalendarForNewReminders()
  return store.calendars(for: .reminder).map { cal in
    [
      "id": cal.calendarIdentifier,
      "title": cal.title,
      "isDefault": cal.calendarIdentifier
        == defaultList?.calendarIdentifier,
    ] as [String: Any]
  }
}

/// Returns reminders matching the given filter and optional list IDs.
///
/// - Parameters:
///   - filter: "pending" | "completed" | "all" (defaults to "all")
///   - listIds: Optional list of reminder-list identifiers to restrict the query.
func listReminders(
  filter: String?,
  listIds: [String]?
) async throws -> [[String: Any]] {
  guard
    EventStoreManager.shared.remindersStatus().permissionStatus == .granted
  else {
    throw IosToolsError.permissionDenied(
      "Reminders permission not granted. Call requestRemindersPermission first."
    )
  }
  let store = EventStoreManager.shared.store

  // Resolve lists.
  var lists: [EKCalendar]? = nil
  if let ids = listIds, !ids.isEmpty {
    let all = store.calendars(for: .reminder)
    let filtered = all.filter { ids.contains($0.calendarIdentifier) }
    if filtered.isEmpty {
      throw IosToolsError.notFound(
        "None of the provided listIds were found."
      )
    }
    lists = filtered
  }

  // Determine completion predicate.
  let resolvedFilter = filter ?? "all"

  // EKEventStore has no direct completion-filtered fetch; instead it
  // provides `predicateForReminders(in:)` and the caller filters.
  // For "pending" and "completed" we also use fetchReminders(matching:)
  // which returns via a callback. We wrap it in async/await.
  let predicate = store.predicateForReminders(in: lists)
  let reminders = try await withCheckedThrowingContinuation {
    (continuation: CheckedContinuation<[EKReminder], Error>) in
    store.fetchReminders(matching: predicate) { fetched in
      if let fetched = fetched {
        continuation.resume(returning: fetched)
      } else {
        continuation.resume(
          throwing: IosToolsError.unknown("fetchReminders returned nil"))
      }
    }
  }

  let filtered: [EKReminder]
  switch resolvedFilter {
  case "pending":
    filtered = reminders.filter { !$0.isCompleted }
  case "completed":
    filtered = reminders.filter { $0.isCompleted }
  default:  // "all"
    filtered = reminders
  }

  return filtered.map(reminderToDict)
}

// MARK: - Helpers

private func reminderToDict(_ r: EKReminder) -> [String: Any] {
  var dict: [String: Any] = [
    "id": r.calendarItemIdentifier,
    "title": r.title ?? "",
    "completed": r.isCompleted,
    "listId": r.calendar?.calendarIdentifier ?? "",
    "listTitle": r.calendar?.title ?? "",
  ]
  // dueMs: prefer dueDateComponents (has exact time) over alarms.
  if let comps = r.dueDateComponents,
    let date = Calendar.current.date(from: comps)
  {
    dict["dueMs"] = date.timeIntervalSince1970 * 1000.0
  }
  if let notes = r.notes, !notes.isEmpty {
    dict["notes"] = notes
  }
  return dict
}
