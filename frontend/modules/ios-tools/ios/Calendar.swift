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
