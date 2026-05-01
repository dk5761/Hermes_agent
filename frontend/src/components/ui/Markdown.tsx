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
import React, { useMemo } from "react";
import { Linking, StyleSheet, type TextStyle, type ViewStyle } from "react-native";
import Markdown from "react-native-markdown-display";
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
  return (
    // The library's default props type doesn't accept ReactNode children well
    // when text is empty; pass a single space to keep heights stable.
    <Markdown style={styleProp} onLinkPress={onLinkPress}>
      {text.length > 0 ? text : " "}
    </Markdown>
  );
}
