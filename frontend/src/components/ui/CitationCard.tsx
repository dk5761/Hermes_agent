/**
 * CitationCard — alternate renderer for `web_search` / `web_extract` /
 * `web_crawl` tool messages.
 *
 * Pulls URL(s) + best-available title/snippet out of the tool's `detail`
 * payload (Hermes tool events vary in shape across versions, so we try a
 * handful of common keys) and renders one compact link card per URL.
 * Favicon comes from Google's S2 service so we don't need an extra fetch
 * round-trip on the device.
 */
import React, { useMemo } from "react";
import { Linking, Pressable, View } from "react-native";
import { Image } from "expo-image";

import { Icon } from "./Icon";
import { Row } from "./Row";
import { Text } from "./Text";
import { useThemeTokens } from "./tokens";

const WEB_TOOL_NAMES: ReadonlySet<string> = new Set([
  "web_search",
  "web_extract",
  "web_crawl",
  "web_fetch",
  "fetch",
  "http",
]);

export function isWebTool(name: string): boolean {
  return WEB_TOOL_NAMES.has(name);
}

interface Citation {
  url: string;
  title?: string;
  snippet?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function pickSnippet(d: Record<string, unknown> | null | undefined): string | undefined {
  return (
    asString(d?.["snippet"]) ??
    asString(d?.["preview"]) ??
    asString(d?.["content"]) ??
    asString(d?.["description"]) ??
    asString(d?.["summary"])
  );
}

// Best-effort extraction. We tolerate any of these shapes:
//   { url: "https://…" }                       single URL
//   { urls: ["https://…", …] }                 web_extract input
//   { query: "…", results: [{url, title, snippet}, …] }
//                                              web_search output
//   { results: [{url, title}, …] }             generic
//   plus a regex fallback over the JSON-stringified detail blob.
function extractCitations(
  detail: Record<string, unknown> | null | undefined,
): Citation[] {
  if (!detail) return [];
  const out: Citation[] = [];
  const seen = new Set<string>();
  const push = (c: Citation) => {
    if (!c.url || seen.has(c.url)) return;
    seen.add(c.url);
    out.push(c);
  };

  const results = asArray(detail["results"]);
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const obj = r as Record<string, unknown>;
    const url = asString(obj["url"]) ?? asString(obj["link"]);
    if (!url) continue;
    push({
      url,
      title: asString(obj["title"]) ?? asString(obj["name"]),
      snippet: pickSnippet(obj),
    });
  }

  for (const u of asArray(detail["urls"])) {
    if (typeof u === "string") push({ url: u });
  }

  const single = asString(detail["url"]);
  if (single) push({ url: single, snippet: pickSnippet(detail) });

  if (out.length === 0) {
    // Last-ditch: regex over the JSON blob.
    let blob = "";
    try {
      blob = JSON.stringify(detail);
    } catch {
      /* ignore */
    }
    const matches = blob.match(/https?:\/\/[^\s"'<>)]+/g);
    if (matches) {
      for (const m of matches) push({ url: m });
    }
  }

  return out.slice(0, 6);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function faviconFor(host: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`;
}

export interface CitationCardRowProps {
  toolName: string;
  status: "running" | "complete" | "error";
  detail: Record<string, unknown> | null | undefined;
  durationMs?: number;
}

function CitationLink({ c }: { c: Citation }) {
  const tokens = useThemeTokens();
  const host = useMemo(() => hostOf(c.url), [c.url]);
  const fav = useMemo(() => faviconFor(host), [host]);
  const onPress = () => {
    void Linking.openURL(c.url).catch(() => undefined);
  };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={c.title ?? host}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: 10,
        alignItems: "flex-start",
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: pressed ? tokens.chip : "transparent",
        borderRadius: 8,
      })}
    >
      <View
        style={{
          width: 28,
          height: 28,
          borderRadius: 6,
          backgroundColor: tokens.chip,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Image
          source={{ uri: fav }}
          style={{ width: 18, height: 18 }}
          contentFit="contain"
          cachePolicy="memory-disk"
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text kind="label" numberOfLines={1}>
          {c.title || host}
        </Text>
        <Text kind="caption" color={tokens.ink3} numberOfLines={1}>
          {host}
        </Text>
        {c.snippet ? (
          <Text
            kind="caption"
            color={tokens.ink2}
            numberOfLines={2}
            style={{ marginTop: 2 }}
          >
            {c.snippet}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function CitationCardRow({
  toolName,
  status,
  detail,
  durationMs,
}: CitationCardRowProps) {
  const tokens = useThemeTokens();
  const citations = useMemo(() => extractCitations(detail), [detail]);
  const dotColor =
    status === "running"
      ? tokens.accent
      : status === "error"
        ? tokens.danger
        : tokens.positive;
  const headerLabel =
    toolName === "web_search"
      ? "Web search"
      : toolName === "web_extract"
        ? "Web extract"
        : toolName === "web_crawl"
          ? "Web crawl"
          : "Web fetch";
  return (
    <View
      className="bg-surface border border-line"
      style={{
        marginHorizontal: 6,
        marginVertical: 4,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <Row
        gap={8}
        align="center"
        justify="space-between"
        style={{
          paddingHorizontal: 12,
          paddingVertical: 8,
          backgroundColor: tokens.sunken,
        }}
      >
        <Row gap={8} align="center">
          <Icon name="globe" size={12} color={tokens.ink2} />
          <Text kind="caption" color={tokens.ink2} style={{ fontWeight: "600" }}>
            {headerLabel}
          </Text>
          {citations.length > 0 ? (
            <Text kind="caption" color={tokens.ink3}>
              · {citations.length} {citations.length === 1 ? "source" : "sources"}
            </Text>
          ) : null}
        </Row>
        <Row gap={6} align="center">
          {durationMs && durationMs > 0 ? (
            <Text kind="caption" mono color={tokens.ink3}>
              {durationMs < 1000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1000).toFixed(1)}s`}
            </Text>
          ) : null}
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: dotColor,
            }}
          />
        </Row>
      </Row>
      {citations.length > 0 ? (
        <View style={{ paddingVertical: 4 }}>
          {citations.map((c, i) => (
            <View key={c.url}>
              {i > 0 ? (
                <View
                  style={{
                    height: 1,
                    marginHorizontal: 14,
                    backgroundColor: tokens.lineSoft,
                  }}
                />
              ) : null}
              <CitationLink c={c} />
            </View>
          ))}
        </View>
      ) : (
        <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
          <Text kind="caption" color={tokens.ink3}>
            No URLs surfaced yet.
          </Text>
        </View>
      )}
    </View>
  );
}
