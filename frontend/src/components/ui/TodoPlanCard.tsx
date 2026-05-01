/**
 * TodoPlanCard — specialized renderer for tool.call rows where name === "todo".
 *
 * Two pieces of UI state, both local/persisted:
 *   - `collapsedByCard` (per cardKey) → hides body + footer, shows 1-line summary
 *   - `pinnedByCard` (per cardKey, max one per session) → caller can render this
 *      same component sticky above the composer
 *
 * Footer (Pin button) is only shown for the latest todo in the session.
 * Step edits / mark-done / reorder are agent-driven (user prompts the agent).
 */
import React, { useEffect, useMemo } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { Icon } from "./Icon";
import { Row } from "./Row";
import { Text } from "./Text";
import { TodoStepRow, type TodoItem } from "./TodoStepRow";
import { useThemeTokens } from "./tokens";
import { useTodosUi } from "@/state/todos";

export type { TodoItem, TodoStatus } from "./TodoStepRow";

export interface TodoPlanCardProps {
  toolCallId: string;
  sessionId: string;
  todos: TodoItem[];
  status: "running" | "complete" | "error";
  isLatest: boolean;
  createdAt: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function deriveTitle(todos: TodoItem[]): string {
  const slugs = todos.slice(0, 3).map((t) =>
    t.content.split(/[\s—:]/)[0]?.toLowerCase().slice(0, 12) ?? "",
  );
  const joined = slugs.filter(Boolean).join(" → ");
  return joined.length > 36 ? joined.slice(0, 33) + "…" : joined;
}

export function deriveProgress(todos: TodoItem[]): {
  done: number;
  total: number;
  activeContent: string;
} {
  const done = todos.filter((t) => t.status === "completed").length;
  const active =
    todos.find((t) => t.status === "in_progress") ??
    todos.find((t) => t.status === "pending");
  return { done, total: todos.length, activeContent: active?.content ?? "" };
}

export function isAnyRunning(todos: TodoItem[]): boolean {
  return todos.some((t) => t.status === "in_progress");
}

// ─── animated subviews ──────────────────────────────────────────────────────

function Spinner({ active, color }: { active: boolean; color: string }) {
  const angle = useSharedValue(0);
  useEffect(() => {
    if (active) {
      angle.value = 0;
      angle.value = withRepeat(
        withTiming(360, { duration: 1200, easing: Easing.linear }),
        -1,
        false,
      );
    } else {
      cancelAnimation(angle);
      angle.value = 0;
    }
    return () => {
      cancelAnimation(angle);
    };
  }, [active, angle]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${angle.value}deg` }],
  }));
  if (!active) return null;
  return (
    <Animated.View style={animStyle}>
      <Icon name="refresh" size={14} color={color} />
    </Animated.View>
  );
}

function Chevron({ collapsed, color }: { collapsed: boolean; color: string }) {
  const rot = useSharedValue(collapsed ? -90 : 0);
  useEffect(() => {
    rot.value = withTiming(collapsed ? -90 : 0, {
      duration: 180,
      easing: Easing.out(Easing.cubic),
    });
  }, [collapsed, rot]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rot.value}deg` }],
  }));
  return (
    <Animated.View style={animStyle}>
      <Icon name="chevD" size={16} color={color} />
    </Animated.View>
  );
}

// Pure inline SVG — keeps the Icon set unchanged while still rendering a
// theme-coloured star with two visual states (outline vs filled).
function StarIcon({
  filled,
  color,
  size = 16,
}: {
  filled: boolean;
  color: string;
  size?: number;
}) {
  const d = "M12 2l3 7h7l-6 4 2 7-6-4-6 4 2-7-6-4h7z";
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d={d}
        fill={filled ? color : "none"}
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

// ─── card ───────────────────────────────────────────────────────────────────

export function TodoPlanCard({
  toolCallId,
  sessionId,
  todos,
  isLatest,
}: TodoPlanCardProps) {
  const tokens = useThemeTokens();
  const cardKey = `${sessionId}:${toolCallId}`;

  const pinned = useTodosUi((s) => !!s.pinnedByCard[cardKey]);
  const collapsed = useTodosUi((s) => !!s.collapsedByCard[cardKey]);
  const togglePinned = useTodosUi((s) => s.togglePinned);
  const toggleCollapsed = useTodosUi((s) => s.toggleCollapsed);

  const title = useMemo(() => deriveTitle(todos), [todos]);
  const progress = useMemo(() => deriveProgress(todos), [todos]);
  const running = useMemo(() => isAnyRunning(todos), [todos]);

  const subtitle =
    progress.total === 0
      ? ""
      : `${progress.done}/${progress.total} done${
          progress.activeContent ? ` · ${progress.activeContent}` : ""
        }`;

  return (
    <View
      className="bg-surface border border-line"
      style={{
        marginHorizontal: 6,
        marginVertical: 4,
        borderRadius: 14,
        overflow: "hidden",
      }}
    >
      {/* Header (always visible). Tapping anywhere outside the chevron does
          nothing — the chevron is its own pressable so users don't accidentally
          collapse when tapping the title. */}
      <Row
        gap={10}
        align="center"
        style={{ paddingHorizontal: 12, paddingVertical: 10 }}
      >
        <View
          className="bg-accent-bg"
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="hash" size={14} color={tokens.accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text kind="h3" numberOfLines={1}>
            {title || "Plan"}
          </Text>
          {subtitle ? (
            <Text kind="caption" color={tokens.ink3} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <Spinner active={running} color={tokens.accent} />
        <Pressable
          onPress={() => toggleCollapsed(cardKey)}
          hitSlop={8}
          style={{
            width: 28,
            height: 28,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Chevron collapsed={collapsed} color={tokens.ink3} />
        </Pressable>
      </Row>

      {!collapsed && todos.length > 0 ? (
        <>
          <View style={{ height: 1, backgroundColor: tokens.lineSoft }} />
          <View>
            {todos.map((item, idx) => (
              <View key={item.id}>
                {idx > 0 ? (
                  <View
                    style={{
                      height: 1,
                      marginLeft: 14 + 18 + 10,
                      backgroundColor: tokens.lineSoft,
                    }}
                  />
                ) : null}
                <TodoStepRow item={item} />
              </View>
            ))}
          </View>
        </>
      ) : null}

      {!collapsed && isLatest ? (
        <>
          <View style={{ height: 1, backgroundColor: tokens.lineSoft }} />
          <Row
            gap={8}
            align="center"
            justify="flex-end"
            style={{ paddingHorizontal: 10, paddingVertical: 10 }}
          >
            <Pressable
              onPress={() => togglePinned(cardKey, sessionId)}
              hitSlop={6}
              style={{ paddingHorizontal: 8, paddingVertical: 6 }}
            >
              <Row gap={6} align="center">
                <StarIcon
                  filled={pinned}
                  color={pinned ? tokens.accent : tokens.ink3}
                />
                <Text
                  kind="label"
                  color={pinned ? tokens.accent : tokens.ink2}
                >
                  {pinned ? "Pinned" : "Pin"}
                </Text>
              </Row>
            </Pressable>
          </Row>
        </>
      ) : null}
    </View>
  );
}
