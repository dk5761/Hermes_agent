/**
 * Toast — minimal animated banner from the top, auto-dismiss in 3s.
 *
 * Exposes `<ToastProvider>` mounted near root, plus `useToast()` returning
 * `{ show: (msg, kind?) => void }`. Slides in from above the safe area.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

export type ToastKind = "info" | "success" | "warning" | "error";

interface ToastValue {
  show: (msg: string, kind?: ToastKind) => void;
}

interface ToastState {
  msg: string;
  kind: ToastKind;
  /** Monotonically increasing key so re-showing identical text re-triggers the animation. */
  key: number;
}

const ToastContext = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  const tokens = useThemeTokens();
  const [state, setState] = useState<ToastState | null>(null);
  // Stable counter survives re-renders without re-creating timer cleanup.
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const offset = useSharedValue(-100);
  const opacity = useSharedValue(0);

  const show = useCallback((msg: string, kind: ToastKind = "info") => {
    counter.current += 1;
    setState({ msg, kind, key: counter.current });
  }, []);

  // Animate in on new state, schedule dismiss after 3s.
  useEffect(() => {
    if (!state) return;
    offset.value = withTiming(0, { duration: 200 });
    opacity.value = withTiming(1, { duration: 200 });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      offset.value = withTiming(-100, { duration: 200 });
      opacity.value = withTiming(0, { duration: 200 });
      // Clear state shortly after exit animation completes.
      setTimeout(() => setState(null), 220);
    }, 3000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [state, offset, opacity]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
    opacity: opacity.value,
  }));

  // Color the banner border-left by toast kind for a quick visual signal.
  const accentBar =
    state?.kind === "success"
      ? tokens.positive
      : state?.kind === "warning"
        ? tokens.warning
        : state?.kind === "error"
          ? tokens.danger
          : tokens.accent;

  const value = useMemo<ToastValue>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {state ? (
        <Animated.View
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              top: insets.top + 8,
              left: 16,
              right: 16,
              zIndex: 100,
            },
            animStyle,
          ]}
        >
          <View
            className="bg-surface border border-line"
            style={{
              borderRadius: 12,
              padding: 12,
              borderLeftWidth: 3,
              borderLeftColor: accentBar,
              shadowColor: "#000",
              shadowOpacity: 0.1,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 4 },
              elevation: 4,
            }}
          >
            <Text kind="body" className="text-ink">
              {state.msg}
            </Text>
          </View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within <ToastProvider>");
  }
  return ctx;
}
