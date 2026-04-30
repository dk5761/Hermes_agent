import { memo, useMemo } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { ACCENT, BORDER, MUTED, PANEL, TEXT } from "@/config";

// Minimal markdown renderer for cron outputs.
//
// WHY hand-rolled instead of `react-native-markdown-display`:
//  - Cron outputs are short, plain markdown (headings, bullets, code, links).
//  - That library pulls a markdown-it tree + several deps (~200KB) for features
//    we don't need; full chat markdown is the Phase 3.5 task and may pick a
//    different lib (KaTeX, GFM tables) so we don't want to commit early.
//  - This implementation handles: ATX headings (#..######), unordered lists
//    (- / *), ordered lists (1.), fenced code (```), inline code (`x`), bold
//    (**x**), italic (*x* / _x_), links ([t](url)), blockquotes (>), hr (---),
//    paragraphs. Tables/HTML/footnotes are intentionally not parsed.

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang?: string; text: string }
  | { kind: "ulist"; items: string[] }
  | { kind: "olist"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "hr" }
  | { kind: "blank" };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      i++;
      continue;
    }

    // Fenced code
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || undefined;
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        code.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++; // consume closing fence
      blocks.push({ kind: "code", lang, text: code.join("\n") });
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        text: heading[2] ?? "",
      });
      i++;
      continue;
    }

    // HR: 3+ of the same char (-, *, or _), separated by optional whitespace.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) && line.trim().length >= 3) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ulist", items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "olist", items });
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        buf.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }

    // Paragraph: consume until blank/structural marker.
    const buf: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^```/.test(lines[i] ?? "") &&
      !/^#{1,6}\s+/.test(lines[i] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[i] ?? "") &&
      !/^\s*>\s?/.test(lines[i] ?? "")
    ) {
      buf.push(lines[i] ?? "");
      i++;
    }
    if (buf.length > 0) {
      blocks.push({ kind: "paragraph", text: buf.join(" ") });
    }
  }

  return blocks;
}

// Inline parser → array of (text | bold | italic | code | link) tokens.
type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  // Order matters: code first (no nested formatting), then links, bold, italic.
  // We do a single-pass regex-or-scan with priority.
  const PATTERN = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)/;

  // Loop: find earliest match; emit preceding text + matched token.
  while (rest.length > 0) {
    const m = PATTERN.exec(rest);
    if (!m) {
      out.push({ kind: "text", text: rest });
      break;
    }
    if (m.index > 0) {
      out.push({ kind: "text", text: rest.slice(0, m.index) });
    }
    const matched = m[0];
    if (m[1]) {
      out.push({ kind: "code", text: matched.slice(1, -1) });
    } else if (m[2]) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(matched);
      if (link) {
        out.push({ kind: "link", text: link[1] ?? "", href: link[2] ?? "" });
      } else {
        out.push({ kind: "text", text: matched });
      }
    } else if (m[3]) {
      out.push({ kind: "bold", text: matched.slice(2, -2) });
    } else if (m[4]) {
      out.push({ kind: "italic", text: matched.slice(1, -1) });
    }
    rest = rest.slice(m.index + matched.length);
  }
  return out;
}

function InlineRun({ tokens }: { tokens: Inline[] }) {
  return (
    <Text style={styles.body}>
      {tokens.map((t, idx) => {
        switch (t.kind) {
          case "text":
            return <Text key={idx}>{t.text}</Text>;
          case "bold":
            return (
              <Text key={idx} style={styles.bold}>
                {t.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={idx} style={styles.italic}>
                {t.text}
              </Text>
            );
          case "code":
            return (
              <Text key={idx} style={styles.inlineCode}>
                {t.text}
              </Text>
            );
          case "link":
            return (
              <Text
                key={idx}
                style={styles.link}
                onPress={() => {
                  void Linking.openURL(t.href);
                }}
              >
                {t.text}
              </Text>
            );
          default:
            return null;
        }
      })}
    </Text>
  );
}

function HeadingBlock({ level, text }: { level: number; text: string }) {
  const style =
    level === 1 ? styles.h1 :
    level === 2 ? styles.h2 :
    level === 3 ? styles.h3 :
    styles.h4;
  return (
    <Text style={[styles.body, style]}>
      <InlineRun tokens={parseInline(text)} />
    </Text>
  );
}

interface MarkdownProps {
  content: string;
}

function MarkdownInner({ content }: MarkdownProps) {
  const blocks = useMemo(() => parseBlocks(content), [content]);

  return (
    <View style={styles.root}>
      {blocks.map((b, idx) => {
        switch (b.kind) {
          case "blank":
            return <View key={idx} style={styles.spacer} />;
          case "hr":
            return <View key={idx} style={styles.hr} />;
          case "heading":
            return <HeadingBlock key={idx} level={b.level} text={b.text} />;
          case "paragraph":
            return (
              <View key={idx} style={styles.para}>
                <InlineRun tokens={parseInline(b.text)} />
              </View>
            );
          case "code":
            return (
              <View key={idx} style={styles.codeBlock}>
                <Text style={styles.codeBlockText}>{b.text}</Text>
              </View>
            );
          case "ulist":
            return (
              <View key={idx} style={styles.list}>
                {b.items.map((item, j) => (
                  <View key={j} style={styles.listRow}>
                    <Text style={[styles.body, styles.bullet]}>{"•"}</Text>
                    <View style={styles.listText}>
                      <InlineRun tokens={parseInline(item)} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case "olist":
            return (
              <View key={idx} style={styles.list}>
                {b.items.map((item, j) => (
                  <View key={j} style={styles.listRow}>
                    <Text style={[styles.body, styles.bullet]}>{`${j + 1}.`}</Text>
                    <View style={styles.listText}>
                      <InlineRun tokens={parseInline(item)} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case "quote":
            return (
              <View key={idx} style={styles.quote}>
                <InlineRun tokens={parseInline(b.text)} />
              </View>
            );
          default:
            return null;
        }
      })}
    </View>
  );
}

export const Markdown = memo(MarkdownInner);

const styles = StyleSheet.create({
  root: { gap: 4 },
  body: { color: TEXT, fontSize: 15, lineHeight: 22 },
  para: { paddingVertical: 4 },
  spacer: { height: 6 },
  hr: { height: 1, backgroundColor: BORDER, marginVertical: 8 },
  h1: { fontSize: 22, fontWeight: "700", marginTop: 12, marginBottom: 4 },
  h2: { fontSize: 19, fontWeight: "700", marginTop: 10, marginBottom: 4 },
  h3: { fontSize: 17, fontWeight: "700", marginTop: 8, marginBottom: 2 },
  h4: { fontSize: 15, fontWeight: "700", marginTop: 6, marginBottom: 2 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  inlineCode: {
    fontFamily: "Menlo",
    fontSize: 13,
    backgroundColor: PANEL,
    color: TEXT,
  },
  link: { color: ACCENT, textDecorationLine: "underline" },
  codeBlock: {
    backgroundColor: PANEL,
    borderColor: BORDER,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginVertical: 6,
  },
  codeBlockText: {
    color: TEXT,
    fontFamily: "Menlo",
    fontSize: 13,
    lineHeight: 18,
  },
  list: { gap: 4, paddingVertical: 4 },
  listRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  bullet: { color: MUTED, minWidth: 18 },
  listText: { flex: 1 },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: BORDER,
    paddingLeft: 10,
    paddingVertical: 4,
    marginVertical: 4,
  },
});
