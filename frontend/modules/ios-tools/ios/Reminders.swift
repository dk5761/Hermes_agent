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

// MARK: - Reminders write methods

/// Creates a new reminder and saves it to the event store.
///
/// - Parameters:
///   - title: The reminder title (required).
///   - dueDateMs: Optional due date as epoch milliseconds.
///   - listId: Optional reminder-list identifier. Uses the default list if omitted.
///   - notes: Optional notes string.
/// - Returns: A dict `{ "id": String }` with the new reminder's identifier.
func addReminder(
  title: String,
  dueDateMs: Double?,
  listId: String?,
  notes: String?
) throws -> [String: Any] {
  guard
    EventStoreManager.shared.remindersStatus().permissionStatus == .granted
  else {
    throw IosToolsError.permissionDenied(
      "Reminders permission not granted. Call requestRemindersPermission first."
    )
  }

  let store = EventStoreManager.shared.store

  // Resolve list.
  let targetList: EKCalendar
  if let lId = listId, !lId.isEmpty {
    guard let list = store.calendar(withIdentifier: lId) else {
      throw IosToolsError.notFound(
        "addReminder: no reminder list found with id '\(lId)'.")
    }
    targetList = list
  } else {
    guard let defaultList = store.defaultCalendarForNewReminders() else {
      throw IosToolsError.unknown(
        "addReminder: could not determine default reminder list.")
    }
    targetList = defaultList
  }

  let reminder = EKReminder(eventStore: store)
  reminder.title = title
  reminder.calendar = targetList

  if let ms = dueDateMs {
    let dueDate = Date(timeIntervalSince1970: ms / 1000.0)
    var comps = Foundation.Calendar.current.dateComponents(
      [.year, .month, .day, .hour, .minute, .second],
      from: dueDate
    )
    // EKReminder expects a calendar on the DateComponents.
    comps.calendar = Foundation.Calendar.current
    reminder.dueDateComponents = comps
  }

  if let notes = notes, !notes.isEmpty {
    reminder.notes = notes
  }

  try store.save(reminder, commit: true)

  return ["id": reminder.calendarItemIdentifier]
}

/// Marks an existing reminder as completed.
///
/// - Parameters:
///   - id: The reminder identifier (from `listReminders` or `addReminder`).
/// - Returns: A dict `{ "ok": true }`.
func completeReminder(id: String) throws -> [String: Any] {
  guard
    EventStoreManager.shared.remindersStatus().permissionStatus == .granted
  else {
    throw IosToolsError.permissionDenied(
      "Reminders permission not granted. Call requestRemindersPermission first."
    )
  }

  let store = EventStoreManager.shared.store

  guard let item = store.calendarItem(withIdentifier: id) else {
    throw IosToolsError.notFound(
      "completeReminder: no calendar item found with id '\(id)'.")
  }
  guard let reminder = item as? EKReminder else {
    throw IosToolsError.notFound(
      "completeReminder: item with id '\(id)' is not a reminder.")
  }

  reminder.isCompleted = true
  reminder.completionDate = Date()

  try store.save(reminder, commit: true)

  return ["ok": true]
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
