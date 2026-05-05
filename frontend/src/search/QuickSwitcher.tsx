/**
 * QuickSwitcher — Phase 4 of the Hermes search feature.
 *
 * Renders the cross-session search modal: sticky search bar, recent-queries
 * empty state, virtualized result list with ⟨MARK⟩-highlighted snippets, and
 * a "no matches" empty state. All data flow goes through `useSearch()` from
 * Phase 3.
 *
 * Modal surface: we reuse the project's `Sheet` (a thin wrapper over gorhom's
 * `BottomSheetModal`) instead of a raw RN `<Modal>`. The plan suggests RN
 * Modal but Sheet is the in-repo convention (`ActionSheet` builds on it),
 * `BottomSheetModalProvider` is already mounted in `app/_layout.tsx`, and we
 * pick up theming + backdrop scrim + pan-down-to-close for free.
 *
 * Imperative-vs-declarative bridge: the public API is `{ visible, onClose }`
 * (per the plan) but `Sheet`'s ref is imperative (`.present()`/`.dismiss()`).
 * We bridge via a `useEffect` watching `visible`, plus an `onChange` from
 * the sheet that fires `onClose` when the user pan-down-dismisses or taps
 * the backdrop (those bypass our `visible` prop).
 *
 * Routing: tapping a result calls `commitToRecent()` to MRU-promote the
 * current query, dismisses the sheet, then deep-links to the chat screen
 * with `messageId` as a query param. The actual scroll-to-message behavior
 * is wired up in Phase 6 — for now the param just rides along.
 *
 * Error retry note: `useSearch` doesn't currently expose a refetch handle,
 * so the in-banner "retry" pokes the query by re-setting it (which fires
 * the debounce + a fresh request). If that proves flaky in practice, we
 * should add a `refetch` to the hook rather than keep adding workarounds.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
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

export interface QuickSwitcherProps {
  visible: boolean;
  onClose: () => void;
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

export function QuickSwitcher({ visible, onClose }: QuickSwitcherProps) {
  const tokens = useThemeTokens();
  const sheetRef = useRef<SheetHandle>(null);
  const inputRef = useRef<TextInput>(null);
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

  // Bridge: { visible } prop → imperative sheet API.
  // We deliberately don't wire `dismiss()` on `visible=false` from inside an
  // onChange-driven flow (would fight the sheet's own animation), but we DO
  // dismiss when the parent flips `visible` to false externally.
  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  // When the user pan-down-dismisses or taps the backdrop, gorhom fires
  // onChange(-1). Surface that as `onClose` so the parent's `visible` state
  // stays in sync with the actual sheet state.
  const onSheetChange = useCallback(
    (idx: number) => {
      if (idx < 0 && visible) onClose();
    },
    [visible, onClose],
  );

  const handlePickResult = useCallback(
    (r: SearchResult) => {
      commitToRecent();
      onClose();
      // The `messageId` deep-link param is consumed by Phase 6's chat screen.
      // Today the chat screen ignores it, so the link still navigates safely.
      router.push(`/chat/${r.sessionId}?messageId=${r.messageId}`);
    },
    [commitToRecent, onClose],
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
            {/* FlashList v2 derives item heights at runtime — no
                estimatedItemSize prop. */}
            <FlashList
              data={results}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              onEndReached={loadMore}
              onEndReachedThreshold={0.5}
              ListFooterComponent={ListFooter}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              contentContainerStyle={{ paddingTop: 4, paddingBottom: 32 }}
            />
          </View>
        ) : null}
      </Stack>
    </Sheet>
  );
}
