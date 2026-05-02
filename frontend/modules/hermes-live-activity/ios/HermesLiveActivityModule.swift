import ActivityKit
import ExpoModulesCore
import Foundation

// JS bridge for ActivityKit. Exposes:
//   start(attrs, state) -> activityId
//   update(activityId, state)
//   end(activityId, finalState?, dismiss?: "default" | "immediate")
//   getPushToken(activityId) -> string?      (waits up to 1.5s for the
//                                            activity's push-to-start /
//                                            push-update token to arrive)
//   listActive() -> [{ id, attrs, state }]
//   endAll()
//
// All methods no-op gracefully on iOS < 16.2 (the host RN process won't
// even import ActivityKit there) and on devices where the user has
// disabled "Live Activities" system-wide.
public class HermesLiveActivityModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HermesLiveActivity")

    Constants([
      "supported": isSupported(),
    ])

    AsyncFunction("isSupported") { () -> Bool in
      isSupported()
    }

    AsyncFunction("areEnabled") { () -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    // Start a new activity. Caller passes plain JSON-shaped dicts; we
    // re-encode into the Codable structs.
    AsyncFunction("start") {
      (attrs: [String: Any], state: [String: Any]) -> String? in
      guard #available(iOS 16.2, *) else { return nil }
      guard ActivityAuthorizationInfo().areActivitiesEnabled else { return nil }
      do {
        let attributes = try decode(
          HermesActivityAttributes.self,
          from: attrs
        )
        let initialState = try decode(
          HermesActivityAttributes.ContentState.self,
          from: state
        )
        let content = ActivityContent(
          state: initialState,
          staleDate: Date().addingTimeInterval(60 * 60 * 8)
        )
        let activity = try Activity<HermesActivityAttributes>.request(
          attributes: attributes,
          content: content,
          pushType: .token
        )
        return activity.id
      } catch {
        return nil
      }
    }

    AsyncFunction("update") {
      (activityId: String, state: [String: Any]) -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      guard
        let activity = Activity<HermesActivityAttributes>.activities
          .first(where: { $0.id == activityId })
      else { return false }
      do {
        let next = try decode(
          HermesActivityAttributes.ContentState.self,
          from: state
        )
        let content = ActivityContent(
          state: next,
          staleDate: Date().addingTimeInterval(60 * 60 * 8)
        )
        await activity.update(content)
        return true
      } catch {
        return false
      }
    }

    AsyncFunction("end") {
      (activityId: String, finalState: [String: Any]?, dismiss: String?) -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      guard
        let activity = Activity<HermesActivityAttributes>.activities
          .first(where: { $0.id == activityId })
      else { return false }
      let policy: ActivityUIDismissalPolicy
      switch dismiss {
      case "immediate": policy = .immediate
      case "after": policy = .default
      default: policy = .default
      }
      let final: ActivityContent<HermesActivityAttributes.ContentState>?
      if let fs = finalState,
        let next = try? decode(
          HermesActivityAttributes.ContentState.self, from: fs)
      {
        final = ActivityContent(
          state: next,
          staleDate: Date().addingTimeInterval(60)
        )
      } else {
        final = nil
      }
      await activity.end(final, dismissalPolicy: policy)
      return true
    }

    AsyncFunction("getPushToken") { (activityId: String) -> String? in
      guard #available(iOS 16.2, *) else { return nil }
      guard
        let activity = Activity<HermesActivityAttributes>.activities
          .first(where: { $0.id == activityId })
      else { return nil }
      // Wait up to ~1.5s for the token to land in pushTokenUpdates.
      var iterator = activity.pushTokenUpdates.makeAsyncIterator()
      let deadline = Date().addingTimeInterval(1.5)
      while Date() < deadline {
        if let token = await iterator.next() {
          return token.map { String(format: "%02x", $0) }.joined()
        }
        try? await Task.sleep(nanoseconds: 100_000_000)
      }
      return nil
    }

    AsyncFunction("listActive") { () -> [[String: Any]] in
      guard #available(iOS 16.2, *) else { return [] }
      return Activity<HermesActivityAttributes>.activities.map {
        activity in
        [
          "id": activity.id,
          "appSessionId": activity.attributes.appSessionId,
          "sessionTitle": activity.attributes.sessionTitle,
          "state": (try? encodeToDict(activity.content.state)) ?? [:],
        ]
      }
    }

    AsyncFunction("endAll") { () -> Void in
      guard #available(iOS 16.2, *) else { return }
      for activity in Activity<HermesActivityAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }
  }

  private func isSupported() -> Bool {
    if #available(iOS 16.2, *) { return true }
    return false
  }
}

// MARK: - JSON helpers

private func decode<T: Codable>(_ type: T.Type, from dict: [String: Any]) throws
  -> T
{
  let data = try JSONSerialization.data(withJSONObject: dict, options: [])
  let decoder = JSONDecoder()
  return try decoder.decode(type, from: data)
}

private func encodeToDict<T: Codable>(_ value: T) throws -> [String: Any] {
  let data = try JSONEncoder().encode(value)
  let obj = try JSONSerialization.jsonObject(with: data, options: [])
  return obj as? [String: Any] ?? [:]
}
