import EventKit
import ExpoModulesCore
import Foundation

// MARK: - Calendar read methods

/// Returns all calendars the user has access to.
/// Requires Calendar access to have been granted (caller must check).
func listCalendars() throws -> [[String: Any]] {
  guard
    EventStoreManager.shared.calendarStatus().permissionStatus == .granted
  else {
    throw IosToolsError.permissionDenied(
      "Calendar permission not granted. Call requestCalendarPermission first."
    )
  }
  let store = EventStoreManager.shared.store
  let defaultCalendar = store.defaultCalendarForNewEvents
  return store.calendars(for: .event).map { cal in
    let result: [String: Any] = [
      "id": cal.calendarIdentifier,
      "title": cal.title,
      "type": calendarTypeName(cal.type),
      "isDefault": cal.calendarIdentifier
        == defaultCalendar?.calendarIdentifier,
    ]
    return result
  }
}

/// Returns events in the given time range, optionally filtered to specific calendars.
///
/// - Parameters:
///   - startMs: Range start as epoch milliseconds.
///   - endMs: Range end as epoch milliseconds.
///   - calendarIds: Optional list of calendar identifiers to restrict the query.
func listEvents(
  startMs: Double, endMs: Double, calendarIds: [String]?
) throws -> [[String: Any]] {
  guard
    EventStoreManager.shared.calendarStatus().permissionStatus == .granted
  else {
    throw IosToolsError.permissionDenied(
      "Calendar permission not granted. Call requestCalendarPermission first."
    )
  }
  let store = EventStoreManager.shared.store
  let startDate = Date(timeIntervalSince1970: startMs / 1000.0)
  let endDate = Date(timeIntervalSince1970: endMs / 1000.0)

  // Resolve calendars: either the requested subset or all event calendars.
  var calendars: [EKCalendar]? = nil
  if let ids = calendarIds, !ids.isEmpty {
    let all = store.calendars(for: .event)
    let filtered = all.filter { ids.contains($0.calendarIdentifier) }
    if filtered.isEmpty {
      throw IosToolsError.notFound(
        "None of the provided calendarIds were found."
      )
    }
    calendars = filtered
  }

  let predicate = store.predicateForEvents(
    withStart: startDate,
    end: endDate,
    calendars: calendars
  )
  let events = store.events(matching: predicate)
  return events.map(eventToDict)
}

// MARK: - Calendar write methods

/// Creates a new calendar event and saves it to the event store.
///
/// - Parameters:
///   - title: The event title (required).
///   - startMs: Start time as epoch milliseconds.
///   - endMs: End time as epoch milliseconds.
///   - calendarId: Optional calendar identifier. Uses the default calendar if omitted.
///   - notes: Optional notes string.
///   - allDay: Whether the event is all-day (defaults to false).
/// - Returns: A dict with `{ "id": String }` holding the new event's identifier.
func addEvent(
  title: String,
  startMs: Double,
  endMs: Double,
  calendarId: String?,
  notes: String?,
  allDay: Bool
) throws -> [String: Any] {
  guard
    EventStoreManager.shared.calendarStatus().permissionStatus == .granted
  else {
    throw IosToolsError.permissionDenied(
      "Calendar permission not granted. Call requestCalendarPermission first."
    )
  }

  // Sanity-check the time range.
  guard endMs > startMs else {
    throw IosToolsError.unknown("addEvent: endMs must be greater than startMs.")
  }
  let fourYearsMs: Double = 4.0 * 365.25 * 24.0 * 3600.0 * 1000.0
  guard (endMs - startMs) <= fourYearsMs else {
    throw IosToolsError.unknown(
      "addEvent: event duration exceeds 4 years (Apple predicate limit).")
  }

  let store = EventStoreManager.shared.store

  // Resolve calendar.
  let targetCalendar: EKCalendar
  if let calId = calendarId, !calId.isEmpty {
    guard let cal = store.calendar(withIdentifier: calId) else {
      throw IosToolsError.notFound(
        "addEvent: no calendar found with id '\(calId)'.")
    }
    targetCalendar = cal
  } else {
    guard let defaultCal = store.defaultCalendarForNewEvents else {
      throw IosToolsError.unknown(
        "addEvent: could not determine default calendar for new events.")
    }
    targetCalendar = defaultCal
  }

  let event = EKEvent(eventStore: store)
  event.title = title
  event.startDate = Date(timeIntervalSince1970: startMs / 1000.0)
  event.endDate = Date(timeIntervalSince1970: endMs / 1000.0)
  event.isAllDay = allDay
  event.calendar = targetCalendar
  if let notes = notes, !notes.isEmpty {
    event.notes = notes
  }

  try store.save(event, span: .thisEvent)

  return ["id": event.eventIdentifier ?? ""]
}

/// Deletes a calendar event by its identifier.
///
/// - Parameters:
///   - id: The event identifier (from `listEvents` or `addEvent`).
/// - Returns: A dict `{ "ok": true }`.
func deleteEvent(id: String) throws -> [String: Any] {
  guard
    EventStoreManager.shared.calendarStatus().permissionStatus == .granted
  else {
    throw IosToolsError.permissionDenied(
      "Calendar permission not granted. Call requestCalendarPermission first."
    )
  }

  let store = EventStoreManager.shared.store

  guard let event = store.event(withIdentifier: id) else {
    throw IosToolsError.notFound(
      "deleteEvent: no event found with id '\(id)'.")
  }

  try store.remove(event, span: .thisEvent)

  return ["ok": true]
}

// MARK: - Helpers

private func calendarTypeName(_ type: EKCalendarType) -> String {
  switch type {
  case .local: return "local"
  case .calDAV: return "icloud"  // CalDAV is used by iCloud; label it clearly
  case .exchange: return "exchange"
  case .subscription: return "subscribed"
  case .birthday: return "birthday"
  @unknown default: return "unknown"
  }
}

private func eventToDict(_ event: EKEvent) -> [String: Any] {
  var dict: [String: Any] = [
    "id": event.eventIdentifier ?? "",
    "title": event.title ?? "",
    "startMs": (event.startDate?.timeIntervalSince1970 ?? 0) * 1000.0,
    "endMs": (event.endDate?.timeIntervalSince1970 ?? 0) * 1000.0,
    "allDay": event.isAllDay,
    "calendarId": event.calendar?.calendarIdentifier ?? "",
    "calendarTitle": event.calendar?.title ?? "",
  ]
  if let notes = event.notes, !notes.isEmpty {
    dict["notes"] = notes
  }
  return dict
}
