import ActivityKit
import Foundation

// Shape mirrored on the JS side in modules/hermes-live-activity/index.ts.
// Two kinds:
//   .chat     — a turn is in flight (Hermes is thinking / running tools)
//   .approval — Hermes is paused waiting on the user to allow / deny
//
// `attributes` is fixed for the activity's lifetime (session id + title).
// `contentState` is what we mutate via `Activity.update()` and via APNs
// pushes from the gateway.
//
// Timer note: `startedAtEpochMs` is the wall-clock start of the run. The
// widget renders elapsed via SwiftUI's `Text(timerInterval:)` which ticks
// on its own — no per-second JS / APNs updates needed. This is what makes
// the timer keep moving even while the agent waits on a sub-agent.
public struct HermesActivityAttributes: ActivityAttributes {
  public typealias HermesStatus = ContentState

  public struct ContentState: Codable, Hashable {
    public enum Kind: String, Codable, Hashable {
      case chat
      case approval
    }

    public let kind: Kind
    // One of: "thinking" | "tool" | "responding" | "awaiting"
    public let status: String
    // Tool name for chat-kind, command summary for approval-kind. Optional
    // because earliest "thinking" frames don't have any detail yet.
    public let detail: String?
    public let startedAtEpochMs: Double
    public let modelName: String?
    public let updatedAtEpochMs: Double
    // Deep link the OS opens when the user taps the activity.
    public let openUrl: String?

    public init(
      kind: Kind,
      status: String,
      detail: String?,
      startedAtEpochMs: Double,
      modelName: String?,
      updatedAtEpochMs: Double,
      openUrl: String?
    ) {
      self.kind = kind
      self.status = status
      self.detail = detail
      self.startedAtEpochMs = startedAtEpochMs
      self.modelName = modelName
      self.updatedAtEpochMs = updatedAtEpochMs
      self.openUrl = openUrl
    }

    public var startedAt: Date {
      Date(timeIntervalSince1970: startedAtEpochMs / 1000.0)
    }
  }

  public let appSessionId: String
  public let sessionTitle: String

  public init(appSessionId: String, sessionTitle: String) {
    self.appSessionId = appSessionId
    self.sessionTitle = sessionTitle
  }
}
