import ActivityKit
import Foundation

// Shape mirrored on the JS side in src/native/live-activity.ts. Two kinds:
//   .chat     — a turn is in flight (Hermes is thinking / running tools)
//   .approval — Hermes is paused waiting on the user to allow / deny
//
// `attributes` is fixed for the activity's lifetime (session id + title).
// `contentState` is what we mutate via `Activity.update()` and via APNs
// pushes from the gateway.
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
    public let elapsedSec: Int
    public let modelName: String?
    public let updatedAtEpochMs: Double
    // Deep link the OS opens when the user taps the activity.
    public let openUrl: String?

    public init(
      kind: Kind,
      status: String,
      detail: String?,
      elapsedSec: Int,
      modelName: String?,
      updatedAtEpochMs: Double,
      openUrl: String?
    ) {
      self.kind = kind
      self.status = status
      self.detail = detail
      self.elapsedSec = elapsedSec
      self.modelName = modelName
      self.updatedAtEpochMs = updatedAtEpochMs
      self.openUrl = openUrl
    }
  }

  public let appSessionId: String
  public let sessionTitle: String

  public init(appSessionId: String, sessionTitle: String) {
    self.appSessionId = appSessionId
    self.sessionTitle = sessionTitle
  }
}
