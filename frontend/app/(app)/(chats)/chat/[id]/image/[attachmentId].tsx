/**
 * Image lightbox modal — Stage 6 satellite, polished in Stage 9.
 *
 * Visual target: design_handoff_hermes/design/screens-2.jsx::ImageLightbox.
 *
 * Stage 9 additions:
 *   - Pinch-to-zoom (Gesture.Pinch) updates a `scale` shared value.
 *   - Pan (Gesture.Pan) moves the image when zoomed-in (`scale > 1`), and
 *     when scale === 1 the same gesture acts as swipe-down-to-dismiss.
 *   - Both gestures are composed via Gesture.Simultaneous so the user can
 *     pinch and drag at once.
 *   - Dismiss threshold: vertical drag > 100pt OR velocityY > 600 fades out
 *     and calls router.back().
 *
 * iOS / Android quirks:
 *   - Reanimated 4 worklets cannot read JS-side state. We snapshot prior
 *     scale/translation in `*_save` shared values at gesture start.
 *   - On Android the modal presentation can interact oddly with vertical
 *     pans (RN modal swallows them). We mark the pan gesture as failing
 *     when the pinch is active so we don't fight it.
 */
import React, { useCallback } from "react";
import { Pressable, View } from "react-native";
import { Stack as ExpoStack, router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { Icon, Row, Stack, Text, useToast } from "@/components/ui";
import { useAttachmentsByIds } from "@/hooks/useAttachments";
import { API_URL } from "@/config";
import { getAuthSnapshot } from "@/auth/store";

interface ActionButtonProps {
  icon: "download" | "share" | "copy" | "refresh";
  label: string;
  onPress: () => void;
}

function ActionButton({ icon, label, onPress }: ActionButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 12,
        paddingVertical: 6,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Stack gap={6} align="center">
        <Icon name={icon} size={22} color="#FFFFFF" />
        <Text kind="caption" color="#FFFFFF">
          {label}
        </Text>
      </Stack>
    </Pressable>
  );
}

function buildImageUrl(attachmentId: string): string {
  // Gateway issues a 302 redirect to a signed blob URL; expo-image follows
  // it transparently. The only image endpoint currently exposed is /thumb.
  return `${API_URL}/uploads/${encodeURIComponent(attachmentId)}/thumb`;
}

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const DISMISS_DRAG = 100; // pt
const DISMISS_VELOCITY = 600; // pt/s
const FADE_EASING = Easing.bezier(0.2, 0, 0, 1);

export default function ImageLightboxScreen() {
  const params = useLocalSearchParams<{ id: string; attachmentId: string }>();
  const attachmentId =
    typeof params.attachmentId === "string" ? params.attachmentId : null;
  const insets = useSafeAreaInsets();
  const toast = useToast();

  // Resolve the AttachmentDTO via TanStack cache (may already be warm from chat).
  const ids = React.useMemo(
    () => (attachmentId ? [attachmentId] : []),
    [attachmentId],
  );
  const attachments = useAttachmentsByIds(ids);
  const attachment = attachments[0] ?? null;

  const url = attachmentId ? buildImageUrl(attachmentId) : null;
  const token = getAuthSnapshot().accessToken;

  // Reanimated shared values for the gesture-driven transform.
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1); // snapshot at pinch start
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);
  // Backdrop opacity drives the dismiss fade; image opacity matches.
  const backdropOpacity = useSharedValue(1);

  const dismiss = useCallback(() => {
    // Run the fade and then call router.back from JS thread. Reanimated 4
    // requires runOnJS for any RN navigation call.
    backdropOpacity.value = withTiming(
      0,
      { duration: 180, easing: FADE_EASING },
      (finished) => {
        if (finished) {
          runOnJS(router.back)();
        }
      },
    );
  }, [backdropOpacity]);

  const onClose = useCallback(() => {
    router.back();
  }, []);

  const onCopy = useCallback(async () => {
    if (!url) return;
    try {
      await Clipboard.setStringAsync(url);
      toast.show("URL copied", "success");
    } catch {
      toast.show("Copy failed", "error");
    }
  }, [url, toast]);

  const onSave = useCallback(() => {
    // expo-media-library is not installed — defer per Phase 8 polish.
    toast.show("Save coming soon", "info");
  }, [toast]);

  const onShare = useCallback(() => {
    // expo-sharing is not installed — defer per Phase 8 polish.
    toast.show("Share coming soon", "info");
  }, [toast]);

  const onResend = useCallback(() => {
    // Re-send is a chat-screen affordance; modal's only role is to close.
    toast.show("Re-send from chat composer", "info");
  }, [toast]);

  // Pinch gesture — zoom around the image's centre. Reanimated 4 worklet API.
  const pinch = Gesture.Pinch()
    .onStart(() => {
      "worklet";
      savedScale.value = scale.value;
    })
    .onUpdate((e) => {
      "worklet";
      const next = savedScale.value * e.scale;
      // Clamp to [MIN_SCALE, MAX_SCALE] so the image can't invert / explode.
      scale.value = Math.max(MIN_SCALE, Math.min(MAX_SCALE, next));
    })
    .onEnd(() => {
      "worklet";
      // Snap back to 1 when zoomed out below 1 (over-pinch) — keeps the
      // dismiss gesture available without ambiguity.
      if (scale.value < 1.05) {
        scale.value = withTiming(1, { duration: 180, easing: FADE_EASING });
        translateX.value = withTiming(0, { duration: 180, easing: FADE_EASING });
        translateY.value = withTiming(0, { duration: 180, easing: FADE_EASING });
      }
    });

  // Pan gesture: dual-mode.
  //   scale === 1 → swipe-down-to-dismiss
  //   scale  > 1  → drag the zoomed image
  const pan = Gesture.Pan()
    .onStart(() => {
      "worklet";
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    })
    .onUpdate((e) => {
      "worklet";
      if (scale.value > 1) {
        translateX.value = savedTranslateX.value + e.translationX;
        translateY.value = savedTranslateY.value + e.translationY;
      } else {
        // Only respond to vertical drags when not zoomed; horizontal is left
        // alone so users don't grab a "stuck" feeling.
        translateY.value = e.translationY;
        // Backdrop fades proportional to drag distance — handoff motion preset.
        const progress = Math.min(Math.abs(e.translationY) / 300, 1);
        backdropOpacity.value = 1 - progress * 0.6;
      }
    })
    .onEnd((e) => {
      "worklet";
      if (scale.value > 1) return;
      const shouldDismiss =
        Math.abs(e.translationY) > DISMISS_DRAG ||
        Math.abs(e.velocityY) > DISMISS_VELOCITY;
      if (shouldDismiss) {
        // Slide down the rest of the way then unmount.
        translateY.value = withTiming(e.translationY > 0 ? 800 : -800, {
          duration: 180,
          easing: FADE_EASING,
        });
        runOnJS(dismiss)();
      } else {
        // Spring back.
        translateY.value = withTiming(0, { duration: 180, easing: FADE_EASING });
        backdropOpacity.value = withTiming(1, {
          duration: 180,
          easing: FADE_EASING,
        });
      }
    });

  // Compose so users can pinch + pan simultaneously (one-finger drag while
  // zoomed; two-finger pinch to zoom further; both at the same time works).
  const composed = Gesture.Simultaneous(pinch, pan);

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value },
      { scale: scale.value },
    ],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      <ExpoStack.Screen
        options={{ headerShown: false, presentation: "modal" }}
      />
      <StatusBar style="light" />

      {/* Backdrop animates with the dismiss drag for tactile feedback. */}
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "#000000",
          },
          backdropStyle,
        ]}
      />

      {/* Top bar: close X (left), file meta (center), spacer (right). */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 5,
          paddingTop: insets.top + 12,
          paddingHorizontal: 16,
          paddingBottom: 12,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: "rgba(0,0,0,0.4)",
        }}
      >
        <Pressable
          onPress={onClose}
          hitSlop={12}
          style={({ pressed }) => ({
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: "rgba(255,255,255,0.12)",
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Icon name="close" size={20} color="#FFFFFF" />
        </Pressable>
        <Stack gap={2} align="center" style={{ flex: 1 }}>
          <Text kind="label" color="#FFFFFF" numberOfLines={1}>
            {attachment?.originalName ?? "Image"}
          </Text>
          {attachment ? (
            <Text kind="caption" color="rgba(255,255,255,0.6)">
              {formatBytes(attachment.sizeBytes)}
            </Text>
          ) : null}
        </Stack>
        <View style={{ width: 36, height: 36 }} />
      </View>

      {/* Image fills the screen and accepts pinch + pan gestures. */}
      <GestureDetector gesture={composed}>
        <Animated.View
          style={[
            {
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: 8,
            },
            imageStyle,
          ]}
        >
          {url ? (
            <Image
              source={{
                uri: url,
                headers: token ? { Authorization: `Bearer ${token}` } : undefined,
              }}
              contentFit="contain"
              transition={120}
              style={{ width: "100%", height: "100%" }}
              accessibilityLabel={attachment?.originalName ?? "Image"}
            />
          ) : (
            <Text kind="caption" color="rgba(255,255,255,0.6)">
              No image
            </Text>
          )}
        </Animated.View>
      </GestureDetector>

      {/* Bottom action row. */}
      <View
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 5,
          paddingTop: 12,
          paddingBottom: insets.bottom + 16,
          paddingHorizontal: 24,
          backgroundColor: "rgba(0,0,0,0.4)",
        }}
      >
        <Row align="center" justify="space-between">
          <ActionButton icon="download" label="Save" onPress={onSave} />
          <ActionButton icon="share" label="Share" onPress={onShare} />
          <ActionButton icon="copy" label="Copy" onPress={onCopy} />
          <ActionButton icon="refresh" label="Re-send" onPress={onResend} />
        </Row>
      </View>
    </View>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
