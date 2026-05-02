import ActivityKit
import SwiftUI
import WidgetKit

// SwiftUI views for the Hermes Live Activity. One ActivityConfiguration
// covers all four placements:
//   - lock-screen / banner
//   - Dynamic Island compact (leading + trailing)
//   - Dynamic Island minimal
//   - Dynamic Island expanded (leading + trailing + bottom)
//
// Colors here intentionally don't read from the app's theme tokens — Live
// Activities run as a separate process. We use system semantic colors so the
// widget tracks iOS dark/light + accent automatically.

@main
struct HermesLiveActivityWidget: WidgetBundle {
  var body: some Widget {
    HermesActivity()
  }
}

struct HermesActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: HermesActivityAttributes.self) { context in
      LockScreenView(
        attributes: context.attributes,
        state: context.state
      )
      .widgetURL(openUrl(context))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          ExpandedLeading(state: context.state)
        }
        DynamicIslandExpandedRegion(.trailing) {
          ExpandedTrailing(state: context.state)
        }
        DynamicIslandExpandedRegion(.bottom) {
          ExpandedBottom(
            attributes: context.attributes,
            state: context.state
          )
        }
      } compactLeading: {
        Image(systemName: glyph(for: context.state))
          .foregroundStyle(.tint)
      } compactTrailing: {
        Text(elapsedString(context.state.elapsedSec))
          .font(.caption2.monospacedDigit())
          .foregroundStyle(.secondary)
      } minimal: {
        Image(systemName: glyph(for: context.state))
          .foregroundStyle(.tint)
      }
      .widgetURL(openUrl(context))
      .keylineTint(.pink)
    }
  }
}

// MARK: - Lock-screen layout

struct LockScreenView: View {
  let attributes: HermesActivityAttributes
  let state: HermesActivityAttributes.ContentState

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          PulsingDot(active: state.kind == .chat)
          Text(headerLabel)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .textCase(.uppercase)
            .tracking(1.4)
        }
        Text(attributes.sessionTitle)
          .font(.headline)
          .lineLimit(1)
        if let detail = state.detail, !detail.isEmpty {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        } else if let model = state.modelName, !model.isEmpty {
          Text(model)
            .font(.caption.monospaced())
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 2) {
        Text(elapsedString(state.elapsedSec))
          .font(.title3.weight(.semibold).monospacedDigit())
        Text(state.kind == .approval ? "tap to respond" : "tap to open")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }

  private var headerLabel: String {
    state.kind == .approval ? "Hermes · awaiting you" : "Hermes · running"
  }
}

// MARK: - Dynamic Island expanded regions

struct ExpandedLeading: View {
  let state: HermesActivityAttributes.ContentState
  var body: some View {
    HStack(spacing: 6) {
      PulsingDot(active: state.kind == .chat)
      Text(state.kind == .approval ? "Awaiting" : "Running")
        .font(.caption.weight(.semibold))
        .foregroundStyle(.secondary)
        .textCase(.uppercase)
        .tracking(1.2)
    }
  }
}

struct ExpandedTrailing: View {
  let state: HermesActivityAttributes.ContentState
  var body: some View {
    Text(elapsedString(state.elapsedSec))
      .font(.headline.monospacedDigit())
      .foregroundStyle(.primary)
  }
}

struct ExpandedBottom: View {
  let attributes: HermesActivityAttributes
  let state: HermesActivityAttributes.ContentState
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(attributes.sessionTitle)
        .font(.headline)
        .lineLimit(1)
      if let detail = state.detail, !detail.isEmpty {
        Text(detail)
          .font(.subheadline)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      } else if let model = state.modelName, !model.isEmpty {
        Text(model)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.top, 4)
  }
}

// MARK: - Helpers

func openUrl(
  _ context: ActivityViewContext<HermesActivityAttributes>
) -> URL? {
  if let s = context.state.openUrl {
    return URL(string: s)
  }
  return URL(string: "hermes://chat/\(context.attributes.appSessionId)")
}

func elapsedString(_ sec: Int) -> String {
  let s = max(0, sec)
  let m = s / 60
  let r = s % 60
  if m > 0 {
    return String(format: "%d:%02d", m, r)
  }
  return "0:\(String(format: "%02d", r))"
}

func glyph(for state: HermesActivityAttributes.ContentState) -> String {
  switch state.kind {
  case .approval:
    return "shield.lefthalf.filled"
  case .chat:
    switch state.status {
    case "tool":
      return "wrench.and.screwdriver.fill"
    case "responding":
      return "text.bubble.fill"
    default:
      return "sparkles"
    }
  }
}

// Tiny animated dot used in the lock-screen + island headers.
struct PulsingDot: View {
  let active: Bool
  @State private var on = false
  var body: some View {
    Circle()
      .fill(active ? Color.pink : Color.gray)
      .frame(width: 6, height: 6)
      .opacity(active ? (on ? 1.0 : 0.35) : 0.6)
      .animation(
        active
          ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true)
          : .default,
        value: on
      )
      .onAppear { on = true }
  }
}
