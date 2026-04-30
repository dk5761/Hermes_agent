# Handoff: Hermes — Mobile (iOS, React Native + NativeWind)

## Overview

Hermes is a mobile companion to a self-hosted LLM gateway. Users:
- chat with multiple models from one account,
- schedule recurring "cron" runs (e.g. daily standup digest, hourly anomaly check),
- triage tool-call approvals on the go,
- manage API keys, vision/aux model assignments, notifications, and storage.

This bundle is a **hi-fi clickable design reference** for the iOS app, including a complete design system intended for **React Native + NativeWind** (similar to the user's `uniwind`).

---

## About the design files

The files in `design/` are **HTML/JSX prototypes**, not production code. They render in a browser via Babel-standalone for fast design iteration; they are not meant to be ported file-by-file. Your job is to **recreate these designs in a real React Native + NativeWind codebase** using the codebase's idioms (Expo Router or React Navigation, AsyncStorage, expo-font, react-native-reanimated, etc.).

The design system tokens, however, **are** ready to drop in: see `theme.ts`, `tailwind.config.js`, `ThemeProvider.tsx` at the root of this folder.

## Fidelity

**Hi-fi.** Colors, typography, spacing, copy, icons, list densities, and interaction states are all final. Recreate pixel-perfect — match exact hex values, font sizes, and spacing tokens documented below.

The few non-final pieces:
- **Charts** (Usage screen): visual targets are correct but data is mocked. Use `react-native-gifted-charts` or `victory-native` and match the visual style.
- **Diagnostics log** (Logs screen): line format is correct, lines themselves are placeholder.
- **Diff view** (Tool detail): matches Git diff conventions; wire to your actual diff source.

---

## Tech stack expectations

- **React Native** (Expo recommended)
- **NativeWind v4** (or the user's `uniwind` — interfaces should be near-identical)
- **expo-font** + `@expo-google-fonts/inter`, `@expo-google-fonts/inter-tight`, `@expo-google-fonts/newsreader`, `@expo-google-fonts/jetbrains-mono`
- **react-native-svg** for icons (Hermes uses inline SVG; copy the icon set out of `design/ui.jsx` → `function Icon`)
- **AsyncStorage** to persist theme variant + mode
- **react-native-safe-area-context** for the notch/home-indicator insets

If `iA Writer Quattro V` is in scope (it gives the **Paper** variant its character), it requires a commercial license — check before shipping. Otherwise fall back to JetBrains Mono for the display font in Paper, which is already wired.

---

## Design system — drop-in files

| File                       | Purpose |
|----------------------------|---------|
| `tailwind.config.js`       | NativeWind config: colors, spacing, radii, font families, font scale |
| `theme.ts`                 | Three palettes × light/dark, font stacks, density, shadows, motion. Pure data + types. |
| `ThemeProvider.tsx`        | Sets active palette as CSS variables via NativeWind's `vars()`. Wrap your root with `<ThemeProvider initialVariant="graphite" initialMode="light">`. |

After dropping these in, **all utility classes from the prototype work directly**:

```tsx
<View className="flex-1 bg-bg">
  <Text className="text-display font-display text-ink">Hello</Text>
  <Text className="text-body text-ink-2">Subtitle</Text>
</View>
```

### Three aesthetic variants

The user explicitly asked to keep all three live so they can decide later. Expose them through a Settings → Appearance screen (already designed — see `Settings → Appearance` in the prototype).

| Variant     | Vibe                              | Display font     | Body font | Mono     | Accent (light) |
|-------------|-----------------------------------|------------------|-----------|----------|----------------|
| **Paper**   | iA Writer warmth, off-white       | iA Writer / JBM  | iA Writer | JetBrains Mono | `#B85C2E` (sienna) |
| **Graphite**| Linear-ish cool neutrals          | Inter Tight      | Inter     | JetBrains Mono | `#4F46E5` (indigo) |
| **Plot**    | Editorial, paper-cream, plum      | Newsreader serif | Inter     | JetBrains Mono | `#6B2E48` (plum)   |

If the user picks one before launch, delete the other two from `palettes` and `fonts` in `theme.ts` and remove the variant picker from Settings.

### Density

Two values, exposed in Settings:
- `compact`: row height 44, section gap 22, cell padding 10×14
- `comfortable`: row height 56, section gap 30, cell padding 14×16

Apply via `useTheme().density` (extend the hook trivially) or via Tailwind utilities + a context flag. Don't try to make every component density-aware — only **list rows, section headers, and card padding** need it.

---

## Screens

Every screen is iOS-first (390×844 logical / 402×874 with dynamic island). Use `SafeAreaView` (top + bottom), no system back button (every screen has its own header bar).

### Navigation map

```
[unauth] ─ Login ─┬─ Onboarding (4 steps) ─┐
                  └────────────────────────▶ Sessions (default tab) ◀─┐
                                              ├─ Chat ◀───────────────┘
                                              │   └─ Tool detail (push)
                                              │   └─ Approval modal (sheet)
                                              │   └─ Image lightbox (modal)
                                              ├─ Search (push)
                                              │
                                            Cron (tab)
                                              ├─ Cron detail
                                              │   └─ Output viewer
                                              └─ New / edit job
                                              │
                                            Settings (tab)
                                              ├─ Main model
                                              ├─ Vision
                                              ├─ Other aux models ─ (per-task picker)
                                              ├─ API keys ─ Key editor
                                              ├─ Notifications
                                              ├─ Storage
                                              ├─ Diagnostics & logs
                                              ├─ Account & security
                                              ├─ Usage
                                              ├─ Toolsets
                                              ├─ Skills
                                              └─ About
```

Use a **bottom tab bar** with three tabs: **Chats / Cron / Settings**. The bar appears on tab roots only, hides on detail pushes (standard iOS pattern). Implementations: `expo-router` tabs, or `@react-navigation/bottom-tabs`.

### Screen-by-screen reference

> For exact layout, copy, colors, and spacing of any screen, **open `design/Hermes Mobile.html` in a browser** and inspect. The Tweaks panel lets you toggle variant/mode/density/font live. Below is the catalogue plus implementation notes.

#### Auth & onboarding
1. **Login** — Server URL field (mono input, prefilled `https://`), username, password, "Sign in" primary button, "Self-hosted? Configure" link below. On success → Sessions.
2. **Onboarding (4 steps)** — Welcome → Connect server → Pick default model → Enable notifications. Progress dots at top, "Skip" top-right except on last step. Last step CTA "Start using Hermes".

#### Chats
3. **Session list** — Search bar pinned at top, "+ New chat" button. Each row: model badge (small mono pill), title, last message preview (1 line, `text-ink-3`), timestamp right-aligned (`text-micro`). Long-press → context menu (Pin / Archive / Delete).
4. **Chat** — Header: title (editable on tap), model name dropdown (→ Main model picker), kebab. Message list inverted (newest at bottom), assistant messages on left with model glyph, user messages right-aligned in a `bg-chip` bubble. Tool calls render as **collapsed cards** with a status pill (`running` / `done` / `failed`) — tap to expand to **Tool detail**. Composer at bottom: textarea (`bg-surface border-line`), `+` for attach, model selector pill on the left, send button right.
5. **Search** — Full-screen, query bar at top. Results grouped: "In titles" / "In messages". Matched text highlighted with `bg-accent-bg text-accent`. Empty state: "Nothing matches" + suggestion chips of recent queries.
6. **Tool detail (push)** — Tool name + args (JSON, syntax-highlighted via `text-mono`), output (preformatted), and a **Diff** section if applicable (red `bg-danger/10` for `-`, green `bg-positive/10` for `+`). Approve / Reject buttons at bottom for pending tools.
7. **Approval modal (sheet)** — Bottom sheet (~70% height). Tool name, brief impact summary, "Approve once" + "Approve always" + "Reject" buttons. Swipe-down dismisses = reject.
8. **Image lightbox (modal)** — Black background, image fit-to-screen, pinch zoom (`react-native-gesture-handler`), close X top-left, share/save buttons bottom-right.

#### Cron
9. **Cron list** — Filter chips: All / Running / Paused. Each row: status dot (positive/warning/danger/ink-3), name, schedule (`every day · 09:00`, mono), last run timestamp, next run countdown. Swipe row left for "Run now" / "Pause".
10. **Cron detail** — Header w/ name + status pill. Sections: Schedule (cron expression in mono + human-readable), Prompt (preview of the seed message), Last 10 runs (compact table: time / duration / token cost / status — tap for output). Footer buttons: "Run now" (accent), "Edit", "Delete" (danger).
11. **Output viewer** — Read-only chat-style view of one run. Header shows run timestamp + duration. Has its own "Re-run with this output as context" button at bottom.
12. **New / edit job** — Form: name, schedule (preset chips: Hourly / Daily / Weekdays / Custom; Custom reveals cron-expression mono input + builder), seed prompt textarea, model selector, notification toggle. Save / Cancel in header.

#### Settings hub + sub-screens
13. **Settings index** — Grouped list (iOS style, but with NativeWind, no native iOS list). Sections: **Models** (Main model, Vision, Other aux models) · **Connection** (API keys, Server URL) · **Device** (Notifications, Storage, Appearance, Density) · **Diagnostics** (Diagnostics & logs, Usage) · **Extend** (Toolsets, Skills) · **Account** (Account & security, About). Each row: label, current value (`text-ink-3`), chevron.
14. **Main model picker** — Full list of available models grouped by provider, search at top, current selection has a checkmark + accent-tinted row. Each row: model name, model id (`text-mono text-ink-3`), context window, $/1M tokens.
15. **Vision** — Same picker pattern, scoped to vision-capable models.
16. **Other aux models** — Hub listing tasks (Summarisation, Title generation, Embeddings, Speech-to-text…). Each → reuses the picker pattern.
17. **API keys** — One row per provider, status badge (`set` / `missing` / `invalid`). Tap → **Key editor** (paste field with mono font, "Test" button that hits a tiny ping endpoint, last-used timestamp).
18. **Notifications** — Toggle list: cron completions, approval requests, server errors. Each toggle row optionally has a sub-row for delivery channel (push / in-app only / silent).
19. **Storage** — Pie/bar visual at top showing app data breakdown: Sessions / Cron history / Cached responses / Logs. Buttons to clear each category individually + "Clear all".
20. **Diagnostics & logs** — Tabs: Hermes / Server / Network. Each tab is a virtualised log list (`FlashList`). Lines: timestamp (mono), level pill, message. Long-press → copy. Footer button "Export logs".
21. **Account & security** — Server URL, signed-in-as, last sync, biometric lock toggle, "Sign out" (danger button).
22. **Usage** — Range selector (7d / 30d / 90d), total spend big number, line chart of daily spend, breakdown by model (rows with bar fills + cost). Cost in mono.
23. **Toolsets** — List of installed toolsets (e.g. Web search, Calendar, GitHub). Toggle to enable per-session by default. Tap → toolset detail (out of scope for v1; row chevron only).
24. **Skills** — Same pattern as Toolsets, for prompt-based skills the user has saved.
25. **About** — App name + version (mono), build number, repo link, third-party licenses.

---

## Components

All in `design/ui.jsx`. Recreate as RN components:

| HTML/JSX name      | RN equivalent (suggested) |
|--------------------|---------------------------|
| `Icon`             | `react-native-svg` set; preserve same names so screen code reads identically |
| `Header`           | `View` with `SafeAreaView` top, height 52 in compact / 56 comfortable. Title centered, leftIcon + rightIcon slots. |
| `Button` (primary/accent/secondary/danger/ghost) | `Pressable` with NativeWind variants (`bg-ink text-surface`, `bg-accent text-surface`, `border border-line`, `bg-danger/10 text-danger`, no bg). Min height 44. |
| `Input`            | `TextInput` with optional left icon. Border `border-line`, focus `border-accent`. |
| `Toggle`           | `Switch` styled, or custom `Pressable` (38×22 track, 18×18 thumb, `bg-positive` on). |
| `Chip`             | Inline `Pressable`, height 28, padding 4×10, `rounded-full`, `bg-chip` default / `bg-ink text-surface` active. |
| `StatusPill`       | Static dot + label combo. Variants: `online` `connecting` `paused` `offline`. Used for sessions/cron/key health. |
| `ListRow`          | Tap row, optional left icon (40×40 rounded-md), title + subtitle, optional right element + chevron. **This is the workhorse — get it right first.** |
| `Section`          | Group container w/ optional title (uppercase mono micro, `text-ink-3`) and bottom subtitle. |
| `BottomSheet`      | Use `@gorhom/bottom-sheet`. |
| `Toast`            | Use `sonner-native` or roll a simple animated `View`. |

The chat composer, model selector pill, cron schedule builder, and diff view are screen-specific — they don't generalise, build them inline in those screens.

---

## Interactions

- **All transitions**: 180ms, `cubic-bezier(0.2, 0, 0, 1)`. Encoded in `theme.motion`.
- **Pushes**: standard iOS slide-from-right.
- **Modals (Tool detail, Image lightbox)**: full-screen modal, slide up.
- **Bottom sheets (Approval, swipe actions)**: spring, snap to 70%/95%/dismiss.
- **Long-press**: 500ms; haptic feedback on trigger (`expo-haptics` `Medium`).
- **Pull-to-refresh** on Sessions, Cron, and run-output lists. Use accent-color spinner.
- **Skeleton loaders** for first paint of any list. Match list-row dimensions exactly to avoid jump.

### Empty states
Every list screen has a designed empty state (see Search, Sessions, Cron, etc. in the prototype). Centered, illustration is a single mono character glyph at 64px in `text-ink-3`, label below in `text-h3`, sub in `text-ink-3`, optional CTA.

### Form validation
- Inline error below the field in `text-danger text-caption`.
- Submit button disabled (opacity 0.4) until valid.
- Server-side errors surface as a `Toast` from the top.

---

## State management

Lightweight — Zustand or Jotai is plenty. No Redux needed.

Stores:
- `useThemeStore` — variant, mode, density, font override. **Persist** to AsyncStorage.
- `useAuthStore` — server URL, token, current user. **Persist token in `expo-secure-store`**, not AsyncStorage.
- `useSessionsStore` — sessions list, current session id, message stream state.
- `useCronStore` — jobs, run history.
- `useSettingsStore` — model selections (main / vision / per-task), API keys (always via secure-store), notification prefs.

Network: tanstack-query is a great fit for the run list / sessions list pagination + invalidation. Streaming chat tokens — use `EventSource` polyfill or fetch with ReadableStream.

---

## Design tokens (full reference)

### Colors — Graphite (primary recommended variant)

| Token       | Light       | Dark        |
|-------------|-------------|-------------|
| bg          | `#F7F8FA`   | `#0B0D11`   |
| surface     | `#FFFFFF`   | `#14171D`   |
| sunken      | `#EEF0F4`   | `#070809`   |
| line        | `#E1E4EA`   | `#222731`   |
| line-soft   | `#ECEEF2`   | `#1A1E26`   |
| chip        | `#EEF0F4`   | `#1B1F27`   |
| ink         | `#0E1116`   | `#EEF1F6`   |
| ink-2       | `#3A4252`   | `#A8B0BF`   |
| ink-3       | `#7A8294`   | `#6A7388`   |
| accent      | `#4F46E5`   | `#8B86FF`   |
| accent-bg   | `#EEF0FF`   | `#1B1B40`   |
| positive    | `#197A4F`   | `#74D29A`   |
| warning     | `#A66A00`   | `#E6B25F`   |
| danger      | `#C2342B`   | `#F26B5E`   |

(Paper and Plot palettes are in `theme.ts` — same shape, different values.)

### Spacing scale

`0` `2` `4` `6` `8` `10` `12` `16` `20` `24` `32` `40` `48` `64` (px) — keys are Tailwind's `0` `0.5` `1` `1.5` `2` `2.5` `3` `4` `5` `6` `8` `10` `12` `16`.

### Radius scale

`sm: 4` · `md: 8` · `lg: 12` · `xl: 16` · `2xl: 20` · `3xl: 28` · `full: 9999`.

### Type scale

| Token   | Size/LH | Weight | Tracking | Use |
|---------|---------|--------|----------|-----|
| display | 32/36   | 600    | -0.6     | Onboarding hero, empty-state titles |
| h1      | 26/32   | 600    | -0.4     | Screen-title large variant |
| h2      | 20/26   | 600    | -0.3     | Section headers in detail screens |
| h3      | 17/22   | 600    | -0.2     | List item title (emphasised) |
| body-lg | 17/24   | 400    | -0.2     | Default chat message text |
| body    | 15/22   | 400    | -0.1     | Default body |
| label   | 13/18   | 500    | 0        | Buttons, chips, list secondary |
| caption | 12/16   | 400    | 0        | Helper / hint text |
| micro   | 11/14   | 500    | 0.4 (uppercase) | Section eyebrows, timestamps |
| mono    | 13/18   | 400    | 0        | Code, IDs, schedules, log lines |

### Shadows

```ts
shadow.sm = { shadowOpacity: 0.04, shadowRadius: 2, offsetY: 1, elevation: 1 }
shadow.md = { shadowOpacity: 0.06, shadowRadius: 12, offsetY: 4, elevation: 3 }
shadow.lg = { shadowOpacity: 0.10, shadowRadius: 32, offsetY: 8, elevation: 8 }
```

iOS shadow color: `#000`. On Android, NativeWind's elevation handles it.

---

## Assets

- **Icons** — inline SVG set in `design/ui.jsx` `Icon` component. Names used: `arrow-left`, `arrow-right`, `arrow-up`, `bell`, `bolt`, `chat`, `check`, `chevron-right`, `clock`, `cog`, `database`, `dot`, `eye`, `image`, `key`, `kebab`, `link`, `lock`, `model`, `pause`, `play`, `plus`, `refresh`, `search`, `share`, `terminal`, `tool`, `trash`, `user`, `wand`, `x`. **Recreate as `react-native-svg`** preserving the same names.
- **Logos / brand** — none provided. Hermes wordmark uses the **display** font for the variant, "Hermes" in title case, no glyph mark by default. If you'd like one, request from design.
- **Fonts** — load via `expo-font` / Google Fonts: Inter, Inter Tight, Newsreader, JetBrains Mono. iA Writer Quattro V is licensed; substitute with JetBrains Mono if not licensed (already wired as fallback).

---

## Files in this bundle

```
design_handoff_hermes/
├── README.md                  ← you are here
├── tailwind.config.js         ← drop into your RN project root
├── theme.ts                   ← palettes + fonts + density + motion
├── ThemeProvider.tsx          ← wraps your app, sets CSS vars
└── design/                    ← reference prototypes (do not ship)
    ├── Hermes Mobile.html     ← open in a browser; Canvas + Device + System views
    ├── tokens.jsx             ← source of theme.ts
    ├── ui.jsx                 ← source of component library (Icon, Button, ListRow…)
    ├── screens-1.jsx          ← Login, SessionList, ChatScreen
    ├── screens-2.jsx          ← Cron list/detail/output/edit, Search, Lightbox
    ├── screens-3.jsx          ← Settings + all sub-screens
    ├── screens-4.jsx          ← Onboarding, Tool detail, Approval modal
    ├── app.jsx                ← prototype navigator (reference for routing only)
    ├── ios-frame.jsx          ← phone bezel — purely a presentation artifact
    ├── design-canvas.jsx      ← canvas overview component — presentation artifact
    └── tweaks-panel.jsx       ← variant/mode toggles — presentation artifact
```

To preview the prototype locally: open `design/Hermes Mobile.html` in any modern browser. Use the toolbar to switch between **Canvas** (all screens at once), **Device** (interactive single phone), and **System** (token reference).

---

## Suggested implementation order

1. Install NativeWind + fonts. Drop in `tailwind.config.js`, `theme.ts`, `ThemeProvider.tsx`. Verify `bg-bg text-ink` works on a blank screen and toggles correctly when you change variant.
2. Build the **component library** from `design/ui.jsx`: `Icon`, `Button`, `ListRow`, `Header`, `Section`, `Chip`, `StatusPill`, `Toggle`, `Input`. Storybook (or just a debug screen) helps.
3. **Settings hub + Account + About** first — easy validation that tokens, list rows, and the Header component all behave.
4. **Sessions list + Chat** — the core. Tackle the composer + tool-call collapse together.
5. **Cron list + detail + editor.**
6. **Onboarding + Login.**
7. Modals, lightbox, search, diagnostics, usage, the rest of Settings.

---

## Questions for the designer (none blocking)

- Final variant pick: Paper / Graphite / Plot — or ship all three as user choice?
- Brand mark or wordmark only?
- Real cron prompt examples / app data for the empty-state and onboarding copy.
