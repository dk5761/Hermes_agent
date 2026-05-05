/**
 * QuickSwitcher — Phase 4 of the Hermes search feature.
 *
 * Imperative ref-driven modal (mirrors ActionSheet / tagsSheet pattern in
 * chats/index.tsx). Parent holds a `QuickSwitcherHandle` ref and calls
 * `.present()` / `.dismiss()` directly. The earlier `{ visible, onClose }`
 * prop API drove gorhom's BottomSheetModal through a useEffect bridge; for
 * reasons we couldn't pin down (likely a React-commit/portal-mount race in
 * gorhom v5), the modal would silently no-op even though present() was
 * being called on a live ref. The ref-driven pattern works.
 */
import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheetFlashList } from "@gorhom/bottom-sheet";
import { router } from "expo-router";

import {
  Chip,
  EmptyState,
  Icon,
  Row,
  Stack,
  Text,
  Sheet,
  type SheetHandle,
  useThemeTokens,
} from "@/components/ui";
import { formatRelative } from "@/util/time";
import { useSearch } from "./useSearch";
import type { SearchResult } from "@/api/search";

export interface QuickSwitcherHandle {
  present: () => void;
  dismiss: () => void;
}

// Backend wraps matched terms with U+27E8 / U+27E9 sentinels (see
// frontend/src/api/search.ts header comment + backend FTS5 snippet() call).
// SNIPPET_RE has a capture group so String#split keeps the marker pairs as
// their own array entries (alternating plain / marked segments).
const SNIPPET_RE = /(⟨MARK⟩.*?⟨\/MARK⟩)/g;
const MARK_PREFIX = "⟨MARK⟩";
const MARK_SUFFIX = "⟨/MARK⟩";

/**
 * renderSnippet — split a snippet on ⟨MARK⟩...⟨/MARK⟩ pairs and render the
 * marked spans accent-colored + bold. The split-and-zip approach keeps each
 * fragment as a nested `<Text>` child so RN's text engine line-wraps the
 * whole snippet as a single paragraph (a `<View>` between fragments would
 * break wrapping).
 *
 * Edge case: snippets with no markers (e.g. title-only matches the backend
 * still returns a context-window for) render as plain text, which is the
 * String.split fallback's natural behavior — the regex match yields an
 * empty array and the alternating loop renders just the first segment.
 */
export function renderSnippet(
  snippet: string,
  accentColor: string,
): React.ReactNode {
  if (!snippet) return null;
  // Split keeps the delimiters because the regex has a capture group.
  const parts = snippet.split(SNIPPET_RE);
  return parts.map((part, i) => {
    if (part.startsWith(MARK_PREFIX) && part.endsWith(MARK_SUFFIX)) {
      const inner = part.slice(MARK_PREFIX.length, -MARK_SUFFIX.length);
      return (
        <Text
          key={i}
          kind="caption"
          style={{ color: accentColor, fontWeight: "700" }}
        >
          {inner}
        </Text>
      );
    }
    return (
      <Text key={i} kind="caption" className="text-ink-3">
        {part}
      </Text>
    );
  });
}

interface ResultRowProps {
  result: SearchResult;
  onPress: (result: SearchResult) => void;
}

function ResultRow({ result, onPress }: ResultRowProps) {
  const tokens = useThemeTokens();
  return (
    <Pressable
      onPress={() => onPress(result)}
      style={({ pressed }) => ({
        marginHorizontal: 16,
        marginBottom: 8,
        padding: 12,
        backgroundColor: tokens.surface,
        borderColor: tokens.line,
        borderWidth: 1,
        borderRadius: 12,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Stack gap={4}>
        <Row align="center" justify="space-between" gap={8}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text kind="label" numberOfLines={1}>
              {result.sessionTitle || "Untitled"}
            </Text>
          </View>
          <Text kind="caption" className="text-ink-3">
            {formatRelative(result.createdAt)}
          </Text>
        </Row>
        {result.snippet ? (
          <Text kind="caption" className="text-ink-3" numberOfLines={2}>
            {renderSnippet(result.snippet, tokens.accent)}
          </Text>
        ) : null}
      </Stack>
    </Pressable>
  );
}

interface RecentListProps {
  recent: ReadonlyArray<string>;
  onPick: (q: string) => void;
  onClear: () => void;
}

function RecentList({ recent, onPick, onClear }: RecentListProps) {
  const tokens = useThemeTokens();
  if (recent.length === 0) {
    return (
      <EmptyState
        icon="search"
        title="Search across your chats"
        body="Find messages by content, code snippets, or session titles."
      />
    );
  }
  return (
    <Stack gap={8} style={{ paddingHorizontal: 16, paddingTop: 4 }}>
      <Row align="center" justify="space-between">
        <Text kind="micro" className="text-ink-3 uppercase">
          Recent searches
        </Text>
        <Pressable onPress={onClear} hitSlop={8}>
          <Text kind="caption" color={tokens.accent}>
            Clear
          </Text>
        </Pressable>
      </Row>
      <Row gap={6} style={{ flexWrap: "wrap" }}>
        {recent.map((q) => (
          <Chip key={q} onPress={() => onPick(q)}>
            {q}
          </Chip>
        ))}
      </Row>
    </Stack>
  );
}

export const QuickSwitcher = forwardRef<QuickSwitcherHandle>(function QuickSwitcher(
  _props,
  ref,
) {
  const tokens = useThemeTokens();
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<SheetHandle>(null);
  const inputRef = useRef<TextInput>(null);
  // Floor padding so list/empty-state content clears the floating AppTabBar
  // (~50pt pill + 4pt margin + safe-area). Mirrors the calc in ActionSheet.
  const tabBarFloor = Math.max(insets.bottom, 12) + 60 + 12;
  const {
    query,
    setQuery,
    results,
    loading,
    error,
    hasMore,
    loadMore,
    recentQueries,
    clearRecent,
    commitToRecent,
  } = useSearch();

  // Imperative handle. Parent calls present()/dismiss() directly via the ref.
  // Defer the underlying sheet present() one frame so gorhom's modal sees a
  // committed children tree (mirrors ActionSheet's setTimeout pattern).
  useImperativeHandle(
    ref,
    () => ({
      present: () => {
        setTimeout(() => sheetRef.current?.present(), 16);
      },
      dismiss: () => sheetRef.current?.dismiss(),
    }),
    [],
  );

  // Reset the input when the sheet is dismissed (idx < 0). Without this,
  // re-opening the sheet would show a stale query.
  const onSheetChange = useCallback(
    (idx: number) => {
      if (idx < 0) setQuery("");
    },
    [setQuery],
  );

  const handlePickResult = useCallback(
    (r: SearchResult) => {
      commitToRecent();
      sheetRef.current?.dismiss();
      // The `messageId` deep-link param is consumed by Phase 6's chat screen.
      // Today the chat screen ignores it, so the link still navigates safely.
      router.push(`/chat/${r.sessionId}?messageId=${r.messageId}`);
    },
    [commitToRecent],
  );

  const handlePickRecent = useCallback(
    (q: string) => {
      setQuery(q);
      // Re-focus so the user can continue editing the recalled query.
      inputRef.current?.focus();
    },
    [setQuery],
  );

  const handleClearInput = useCallback(() => {
    setQuery("");
    inputRef.current?.focus();
  }, [setQuery]);

  const handleRetry = useCallback(() => {
    // useSearch doesn't expose refetch yet; re-setting the same query
    // re-triggers the debounce + a fresh fetch via TanStack's queryKey.
    setQuery(query);
  }, [query, setQuery]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;
  const showInitialEmpty = !hasQuery && !loading;
  const showNoMatches =
    hasQuery && !loading && !error && results.length === 0;
  const showResults = hasQuery && results.length > 0;

  const keyExtractor = useCallback(
    (r: SearchResult) => String(r.messageId),
    [],
  );

  const renderItem = useCallback(
    ({ item }: { item: SearchResult }) => (
      <ResultRow result={item} onPress={handlePickResult} />
    ),
    [handlePickResult],
  );

  const ListFooter = useMemo(() => {
    if (!hasMore) return null;
    return (
      <View style={{ paddingVertical: 16, alignItems: "center" }}>
        <ActivityIndicator size="small" color={tokens.accent} />
      </View>
    );
  }, [hasMore, tokens.accent]);

  return (
    <Sheet
      ref={sheetRef}
      snapPoints={["85%"]}
      onChange={onSheetChange}
      enablePanDownToClose
      enableDynamicSizing={false}
    >
      <Stack gap={0} style={{ flex: 1 }}>
        {/* Sticky search bar. Mirrors Input.tsx styling but uses a raw
            TextInput so we can attach our own ref + autoFocus reliably
            inside the sheet. */}
        <View style={{ paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 }}>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              height: 44,
              paddingHorizontal: 12,
              borderRadius: 10,
              gap: 8,
              borderWidth: 1,
              borderColor: tokens.line,
              backgroundColor: tokens.surface,
            }}
          >
            <Icon name="search" size={16} color={tokens.ink3} />
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Search across chats"
              placeholderTextColor={tokens.ink3}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={{
                flex: 1,
                fontSize: 15,
                letterSpacing: -0.1,
                color: tokens.ink,
                fontFamily: "Inter_400Regular",
                paddingVertical: 0,
              }}
            />
            {loading ? (
              <ActivityIndicator size="small" color={tokens.ink3} />
            ) : null}
            {hasQuery ? (
              <Pressable onPress={handleClearInput} hitSlop={8}>
                <Icon name="close" size={16} color={tokens.ink3} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {error ? (
          <Pressable
            onPress={handleRetry}
            style={{
              marginHorizontal: 16,
              marginBottom: 8,
              padding: 10,
              borderRadius: 10,
              backgroundColor: tokens.accentBg,
            }}
          >
            <Row align="center" justify="space-between" gap={8}>
              <Text kind="caption" color={tokens.danger} style={{ flex: 1 }}>
                {error.message || "Search failed"}
              </Text>
              <Text kind="caption" color={tokens.accent}>
                Retry
              </Text>
            </Row>
          </Pressable>
        ) : null}

        {showInitialEmpty ? (
          <View style={{ flex: 1 }}>
            <RecentList
              recent={recentQueries}
              onPick={handlePickRecent}
              onClear={clearRecent}
            />
          </View>
        ) : null}

        {showNoMatches ? (
          <View style={{ flex: 1 }}>
            <EmptyState
              icon="search"
              title="No matches"
              body={`Nothing found for "${trimmed}". Try a different query.`}
            />
          </View>
        ) : null}

        {showResults ? (
          <View style={{ flex: 1 }}>
            {/* BottomSheetFlashList — gorhom-aware list that cooperates with
                the sheet's gesture handler so scrolling works inside the
                modal. Plain FlashList swallows the scroll gesture. */}
            <BottomSheetFlashList
              data={results}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              onEndReached={loadMore}
              onEndReachedThreshold={0.5}
              ListFooterComponent={ListFooter}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={{ paddingTop: 4, paddingBottom: tabBarFloor }}
            />
          </View>
        ) : null}
      </Stack>
    </Sheet>
  );
});
