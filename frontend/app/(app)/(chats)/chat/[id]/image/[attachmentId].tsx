/**
 * Image lightbox modal — Stage 6 satellite.
 *
 * Visual target: design_handoff_hermes/design/screens-2.jsx::ImageLightbox.
 *
 * Always-dark presentation regardless of the active theme — matches the
 * design's "viewer chrome" aesthetic where the image dominates.
 *
 * Presented as a modal route. Source attachment is fetched via the
 * existing useAttachmentsByIds hook (TanStack-cached). The signed image URL
 * comes from `${API_URL}/uploads/:id` (the gateway issues a redirect with
 * `Authorization` headers — expo-image follows it transparently).
 *
 * Phase 6 deliberately ships without pinch-zoom or swipe-dismiss gestures
 * (see "Punted" notes in the report) — the design calls for them but the
 * gesture wiring is Phase 8 polish.
 */
import React, { useCallback } from "react";
import { Pressable, View } from "react-native";
import { Stack as ExpoStack, router, useLocalSearchParams } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  // it transparently. The only image endpoint currently exposed is /thumb —
  // upgrade to a full-resolution endpoint when one ships (Phase 8).
  return `${API_URL}/uploads/${encodeURIComponent(attachmentId)}/thumb`;
}

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

  return (
    <View style={{ flex: 1, backgroundColor: "#000000" }}>
      <ExpoStack.Screen
        options={{ headerShown: false, presentation: "modal" }}
      />
      <StatusBar style="light" />

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

      {/* Image fills the screen. */}
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: 8,
        }}
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
      </View>

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
