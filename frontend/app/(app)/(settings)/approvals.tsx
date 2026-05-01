/**
 * Approval policy editor — `/(settings)/approvals`.
 *
 * Lists Hermes' permanent allowlist (config.command_allowlist). Each row is
 * a pattern key (e.g. "rm", "git push"). Swipe-right or tap delete to remove.
 * Bottom row adds a new pattern.
 *
 * Session-scoped approvals are not editable here — they're added via the
 * inline ApprovalCard's "Allow always" button on a per-prompt basis.
 */
import { useCallback, useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  View,
  type ListRenderItem,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";

import {
  Button,
  EmptyState,
  Icon,
  Input,
  NavBar,
  PhoneSafeArea,
  Row,
  Section,
  showToast,
  Stack,
  Text,
  useThemeTokens,
} from "@/components/ui";
import {
  addApproval,
  listApprovals,
  removeApproval,
} from "@/api/approvals";

const QUERY_KEY = ["settings", "approvals"] as const;

export default function ApprovalPolicyScreen() {
  const router = useRouter();
  const tokens = useThemeTokens();
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const listQ = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listApprovals,
  });

  const add = useMutation({
    mutationFn: (pattern: string) => addApproval(pattern),
    onSuccess: (patterns) => {
      qc.setQueryData(QUERY_KEY, patterns);
      setDraft("");
      showToast("Pattern allowed", "success");
    },
    meta: { silent: true },
  });

  const remove = useMutation({
    mutationFn: (pattern: string) => removeApproval(pattern),
    onSuccess: (patterns) => {
      qc.setQueryData(QUERY_KEY, patterns);
    },
    meta: { silent: true },
  });

  const onAdd = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    add.mutate(trimmed);
  }, [draft, add]);

  const onRemove = useCallback(
    (pattern: string) => {
      Alert.alert(
        "Remove pattern?",
        `"${pattern}" will require approval again the next time it's used.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => remove.mutate(pattern),
          },
        ],
      );
    },
    [remove],
  );

  const renderItem = useCallback<ListRenderItem<string>>(
    ({ item }) => (
      <SwipeRow pattern={item} onRemove={() => onRemove(item)} />
    ),
    [onRemove],
  );

  const patterns = listQ.data ?? [];

  return (
    <PhoneSafeArea>
      <NavBar title="Approval policy" onBack={() => router.back()} />

      <FlatList
        data={patterns}
        keyExtractor={(p) => p}
        renderItem={renderItem}
        ListHeaderComponent={
          <Stack gap={12} style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
            <Text kind="caption" color={tokens.ink3}>
              Patterns listed here run without prompting. Sessions can also
              allow patterns ad-hoc — those expire when the chat ends.
            </Text>
          </Stack>
        }
        ListEmptyComponent={
          listQ.isLoading ? null : (
            <EmptyState
              icon="shieldCheck"
              title="No always-allowed patterns"
              body="Add a pattern below or tap “Allow forever” on a future approval prompt."
            />
          )
        }
        ListFooterComponent={
          <View style={{ marginTop: 18 }}>
          <Section title="Add pattern">
            <View
              className="bg-surface border border-line"
              style={{
                marginHorizontal: 16,
                padding: 12,
                borderRadius: 12,
                gap: 10,
              }}
            >
              <Input
                value={draft}
                onChange={setDraft}
                placeholder="e.g. find, git push, rm"
                mono
                onSubmit={onAdd}
              />
              <Text kind="caption" color={tokens.ink3}>
                Pattern matches Hermes' command-key heuristic — usually the
                first word, sometimes a multi-word phrase like “git push”.
              </Text>
              <Button
                kind="accent"
                full
                disabled={draft.trim().length === 0 || add.isPending}
                onPress={onAdd}
              >
                {add.isPending ? "Adding…" : "Add to allowlist"}
              </Button>
              {add.isError ? (
                <Text kind="caption" color={tokens.danger}>
                  {(add.error as Error).message}
                </Text>
              ) : null}
            </View>
          </Section>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 80, flexGrow: 1 }}
      />
    </PhoneSafeArea>
  );
}

// ─── row + swipe ───────────────────────────────────────────────────────────

interface SwipeRowProps {
  pattern: string;
  onRemove: () => void;
}

function SwipeRow({ pattern, onRemove }: SwipeRowProps) {
  const tokens = useThemeTokens();
  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={56}
      renderRightActions={(_progress, drag) => <SwipeActionBg drag={drag} />}
      onSwipeableOpen={(direction) => {
        if (direction === "right") onRemove();
      }}
    >
      <Pressable
        onLongPress={onRemove}
        style={({ pressed }) => ({
          opacity: pressed ? 0.7 : 1,
          paddingVertical: 14,
          paddingHorizontal: 16,
          flexDirection: "row",
          gap: 12,
          alignItems: "center",
          backgroundColor: tokens.bg,
          borderBottomWidth: 1,
          borderBottomColor: tokens.lineSoft,
        })}
      >
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            backgroundColor: tokens.accentBg,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="shieldCheck" size={14} color={tokens.accent} />
        </View>
        <Text kind="body-lg" mono numberOfLines={1} style={{ flex: 1 }}>
          {pattern}
        </Text>
        <Pressable onPress={onRemove} hitSlop={8}>
          <Icon name="trash" size={16} color={tokens.ink3} />
        </Pressable>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

function SwipeActionBg({ drag }: { drag: SharedValue<number> }) {
  const tokens = useThemeTokens();
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: drag.value + 80 }],
  }));
  return (
    <View
      style={{
        width: 80,
        backgroundColor: tokens.danger,
        justifyContent: "center",
      }}
    >
      <Animated.View style={[{ alignItems: "center" }, animStyle]}>
        <Icon name="trash" size={18} color={tokens.surface} />
        <Text
          kind="caption"
          color={tokens.surface}
          style={{ marginTop: 4, fontWeight: "600" }}
        >
          Remove
        </Text>
      </Animated.View>
    </View>
  );
}
