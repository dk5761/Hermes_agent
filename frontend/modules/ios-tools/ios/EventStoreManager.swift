import EventKit
import Foundation

/// Shared, lazily-created EKEventStore singleton.
///
/// EKEventStore is expensive to initialise (it loads the entire
/// EventKit database) so we create exactly one instance and reuse it
/// for every Calendar and Reminders call.
final class EventStoreManager {

  // MARK: - Singleton

  static let shared = EventStoreManager()
  private init() {}

  // MARK: - Store

  let store = EKEventStore()

  // MARK: - Calendar auth

  /// Requests full Calendar access.
  ///
  /// - On iOS 17+ uses `requestFullAccessToEventsWithCompletion:`.
  /// - On iOS 16 falls back to `requestAccessToEntityType:completion:`.
  ///   Both are called via their completion-handler Obj-C form wrapped in
  ///   `withCheckedThrowingContinuation` to avoid using the deprecated Swift
  ///   async wrapper which causes a compiler warning on the iOS 16 path.
  func requestCalendarAccess() async throws -> EKAuthorizationStatus {
    let granted: Bool
    if #available(iOS 17, *) {
      granted = try await store.requestFullAccessToEvents()
    } else {
      granted = try await withCheckedThrowingContinuation { continuation in
        store.requestAccess(to: .event) { ok, error in
          if let error = error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: ok)
          }
        }
      }
    }
    return granted ? .authorized : .denied
  }

  /// Current Calendar authorisation status without prompting.
  func calendarStatus() -> EKAuthorizationStatus {
    EKEventStore.authorizationStatus(for: .event)
  }

  // MARK: - Reminders auth

  /// Requests full Reminders access.
  ///
  /// - On iOS 17+ uses `requestFullAccessToRemindersWithCompletion:`.
  /// - On iOS 16 falls back to `requestAccessToEntityType:completion:`.
  func requestRemindersAccess() async throws -> EKAuthorizationStatus {
    let granted: Bool
    if #available(iOS 17, *) {
      granted = try await store.requestFullAccessToReminders()
    } else {
      granted = try await withCheckedThrowingContinuation { continuation in
        store.requestAccess(to: .reminder) { ok, error in
          if let error = error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume(returning: ok)
          }
        }
      }
    }
    return granted ? .authorized : .denied
  }

  /// Current Reminders authorisation status without prompting.
  func remindersStatus() -> EKAuthorizationStatus {
    EKEventStore.authorizationStatus(for: .reminder)
  }
}
