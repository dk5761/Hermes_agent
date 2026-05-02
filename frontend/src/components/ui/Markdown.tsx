/**
 * MarkdownView — thin wrapper around `react-native-markdown-display`.
 *
 * Maps markdown-it AST nodes to our design system: type-scale via Text utility
 * sizes, mono blocks via JetBrains Mono with a sunken background, links in
 * accent color. We compute styles + rules off the active theme tokens so
 * theme switches re-style without remount.
 *
 * The library expects flat StyleSheet.NamedStyles, so we stay in inline-style
 * land here rather than Tailwind class names.
 */
import React, { useCallback, useMemo } from "react";
import {
  Linking,
  Pressable,
  Share,
  StyleSheet,
  Text as RNText,
  View,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Markdown, { type RenderRules } from "react-native-markdown-display";
import * as Clipboard from "expo-clipboard";
import { Icon } from "./Icon";
import { useThemeTokens, type ThemeTokens } from "./tokens";

export interface MarkdownViewProps {
  text: string;
}

function buildStyles(t: ThemeTokens): Record<string, TextStyle | ViewStyle> {
  // Type scale numbers mirror global.css `text-*` utilities so on-screen
  // markdown matches the rest of the chat copy. Heading sizes from the design
  // (h1=26, h2=21, h3=18 per ui.jsx).
  return StyleSheet.create({
    body: {
      color: t.ink,
      fontFamily: "Inter_400Regular",
      fontSize: 15,
      lineHeight: 22,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 8,
      color: t.ink,
      fontSize: 15,
      lineHeight: 22,
    },
    strong: {
      fontFamily: "Inter_600SemiBold",
      fontWeight: "600",
    },
    em: {
      fontStyle: "italic",
    },
    s: {
      textDecorationLine: "line-through",
    },
    heading1: {
      fontFamily: "InterTight_600SemiBold",
      fontSize: 26,
      lineHeight: 32,
      letterSpacing: -0.4,
      color: t.ink,
      marginTop: 12,
      marginBottom: 6,
      fontWeight: "600",
    },
    heading2: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 21,
      lineHeight: 26,
      letterSpacing: -0.2,
      color: t.ink,
      marginTop: 10,
      marginBottom: 6,
      fontWeight: "600",
    },
    heading3: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 18,
      lineHeight: 22,
      color: t.ink,
      marginTop: 8,
      marginBottom: 4,
      fontWeight: "600",
    },
    heading4: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 16,
      lineHeight: 20,
      color: t.ink,
      marginTop: 6,
      marginBottom: 4,
      fontWeight: "600",
    },
    heading5: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 15,
      lineHeight: 20,
      color: t.ink,
      marginTop: 6,
      marginBottom: 4,
      fontWeight: "600",
    },
    heading6: {
      fontFamily: "Inter_600SemiBold",
      fontSize: 14,
      lineHeight: 18,
      color: t.ink2,
      marginTop: 6,
      marginBottom: 4,
      fontWeight: "600",
    },
    link: {
      color: t.accent,
      textDecorationLine: "underline",
    },
    blockquote: {
      borderLeftWidth: 2,
      borderLeftColor: t.line,
      paddingLeft: 12,
      paddingVertical: 4,
      marginVertical: 4,
      backgroundColor: "transparent",
    },
    bullet_list: {
      marginVertical: 4,
    },
    ordered_list: {
      marginVertical: 4,
    },
    list_item: {
      marginBottom: 2,
      flexDirection: "row",
    },
    bullet_list_icon: {
      color: t.ink3,
      marginRight: 6,
      marginLeft: 0,
      lineHeight: 22,
    },
    ordered_list_icon: {
      color: t.ink3,
      marginRight: 6,
      marginLeft: 0,
      lineHeight: 22,
    },
    bullet_list_content: {
      flex: 1,
    },
    ordered_list_content: {
      flex: 1,
    },
    code_inline: {
      fontFamily: "JetBrainsMono_400Regular",
      fontSize: 13,
      backgroundColor: t.sunken,
      color: t.ink2,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 4,
    },
    code_block: {
      fontFamily: "JetBrainsMono_400Regular",
      fontSize: 13,
      lineHeight: 18,
      backgroundColor: t.sunken,
      borderColor: t.lineSoft,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      color: t.ink2,
      marginVertical: 6,
    },
    fence: {
      fontFamily: "JetBrainsMono_400Regular",
      fontSize: 13,
      lineHeight: 18,
      backgroundColor: t.sunken,
      borderColor: t.lineSoft,
      borderWidth: 1,
      borderRadius: 10,
      padding: 12,
      color: t.ink2,
      marginVertical: 6,
    },
    hr: {
      backgroundColor: t.line,
      height: 1,
      marginVertical: 10,
    },
    table: {
      borderWidth: 1,
      borderColor: t.line,
      borderRadius: 8,
      marginVertical: 6,
    },
    thead: {
      backgroundColor: t.sunken,
    },
    th: {
      padding: 8,
      borderColor: t.line,
    },
    td: {
      padding: 8,
      borderColor: t.lineSoft,
    },
  });
}

// Custom fenced code block renderer: language label + Copy + Share icons in
// a header strip, code body styled with the same fence styles below. Mirrors
// the ChatGPT/Claude layout so users can grab snippets without having to
// triple-tap-select.
function CodeBlock({
  code,
  language,
  tokens,
}: {
  code: string;
  language: string;
  tokens: ThemeTokens;
}) {
  const onCopy = useCallback(() => {
    void Clipboard.setStringAsync(code).catch(() => undefined);
  }, [code]);
  const onShare = useCallback(() => {
    void Share.share({ message: code }).catch(() => undefined);
  }, [code]);
  return (
    <View
      style={{
        backgroundColor: tokens.sunken,
        borderColor: tokens.lineSoft,
        borderWidth: 1,
        borderRadius: 10,
        marginVertical: 6,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 10,
          paddingVertical: 6,
          backgroundColor: tokens.chip,
        }}
      >
        <RNText
          style={{
            color: tokens.ink3,
            fontFamily: "JetBrainsMono_400Regular",
            fontSize: 11,
            textTransform: "lowercase",
          }}
          numberOfLines={1}
        >
          {language || "code"}
        </RNText>
        <View style={{ flexDirection: "row", gap: 4 }}>
          <Pressable
            onPress={onCopy}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Copy code"
            style={({ pressed }) => ({
              width: 24,
              height: 24,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Icon name="copy" size={12} color={tokens.ink3} />
          </Pressable>
          <Pressable
            onPress={onShare}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Share code"
            style={({ pressed }) => ({
              width: 24,
              height: 24,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 6,
              opacity: pressed ? 0.5 : 1,
            })}
          >
            <Icon name="share" size={12} color={tokens.ink3} />
          </Pressable>
        </View>
      </View>
      <RNText
        style={{
          fontFamily: "JetBrainsMono_400Regular",
          fontSize: 13,
          lineHeight: 18,
          color: tokens.ink2,
          padding: 12,
        }}
        selectable
      >
        {code.replace(/\n$/, "")}
      </RNText>
    </View>
  );
}

export function MarkdownView({ text }: MarkdownViewProps): React.ReactElement {
  const tokens = useThemeTokens();
  const styles = useMemo(() => buildStyles(tokens), [tokens]);
  // Library typings expect StyleSheet.NamedStyles<any>; cast at the call site
  // to avoid a leaky any in our public surface.
  const styleProp = styles as unknown as Record<string, object>;
  const onLinkPress = (url: string): boolean => {
    void Linking.openURL(url).catch(() => undefined);
    // Return true so the library doesn't fall back to its default opener.
    return true;
  };
  // Override the library's default fence + code_block renderers so each
  // snippet gets a header bar with copy/share. The library passes us the
  // full markdown-it node — `node.content` is the code text, `node.sourceInfo`
  // is the language fence info (e.g. "ts", "bash").
  const rules: RenderRules = useMemo(
    () => ({
      fence: (node) => {
        const n = node as { key: string; content?: string; sourceInfo?: string };
        return (
          <CodeBlock
            key={n.key}
            code={n.content ?? ""}
            language={(n.sourceInfo ?? "").split(/\s+/)[0] ?? ""}
            tokens={tokens}
          />
        );
      },
      code_block: (node) => {
        const n = node as { key: string; content?: string };
        return (
          <CodeBlock
            key={n.key}
            code={n.content ?? ""}
            language=""
            tokens={tokens}
          />
        );
      },
    }),
    [tokens],
  );
  return (
    // The library's default props type doesn't accept ReactNode children well
    // when text is empty; pass a single space to keep heights stable.
    <Markdown style={styleProp} onLinkPress={onLinkPress} rules={rules}>
      {text.length > 0 ? text : " "}
    </Markdown>
  );
}
