# Hermes mobile — UI rebuild plan (Uniwind + design_handoff_hermes)

Migrate the existing Expo app from raw `StyleSheet`+constants to **Uniwind v1.6.3 + Tailwind v4** with the **design_handoff_hermes** design system. End state: pixel-faithful reimplementation of every prototype screen in `design_handoff_hermes/design/` running natively on iOS + Android.

The plan is **stage-gated**. Each stage ships, typechecks, and visually verifies before the next starts. Stages 0–3 are foundational (single-pass). Stages 4+ migrate screens incrementally — each screen is independently shippable so we can pause between any two stages without regressing.

---

## 0. Scope summary

**In scope** (all 25 screens listed in `design_handoff_hermes/README.md`):
- Auth + onboarding (5 screens)
- Sessions + chat (4 screens + tool detail, approval modal, image lightbox)
- Cron (4 screens)
- Settings hub + 13 sub-screens
- Bottom tab bar (Chats / Cron / Settings)
- 3 themes × light/dark = 6 palettes, switchable at runtime
- 4 type families: Inter, Inter Tight, Newsreader, JetBrains Mono
- 2 densities: compact / comfortable
- Component library (~20 primitives) per `design/ui.jsx`

**Out of scope** (this rebuild):
- iA Writer Quattro V (commercial license — fall back to JetBrains Mono per handoff §1)
- Charts library beyond visual style
- Cloud sync of theme prefs (local AsyncStorage only)

**Backend changes**: zero. The gateway API is stable; this is frontend-only.

---

## 1. Stack diff

| Concern | Today | After |
|---|---|---|
| Styling | inline `StyleSheet` + theme constants | Uniwind classNames + Tailwind v4 + CSS variables |
| Theme | static dark + accent | 3 palettes × light/dark, runtime switch via `Uniwind.setTheme()` |
| Fonts | system | `expo-font` + `@expo-google-fonts/{inter,inter-tight,newsreader,jetbrains-mono}` |
| Icons | none / unicode | `react-native-svg`, ~40 inline icon set ported from `design/ui.jsx` |
| Navigation | flat stack | bottom tabs (Chats / Cron / Settings) + nested stacks |
| Markdown | regex parser | replace with `react-native-markdown-display` (cleaner) |
| Bottom sheets | native Alert | `@gorhom/bottom-sheet` |
| Lightbox | none | `react-native-image-zoom-viewer` or custom (gesture-handler) |
| Density | none | persisted toggle |

**No removal of business logic** — all stores (auth, chat, pending-attachments, cron prefs), API clients, WS code, hooks stay as-is. We swap only the presentation layer.

---

## 2. Stage 0 — Pre-flight (no code yet)

Goal: lock in the recipe before touching the app.

**Tasks**
1. Snapshot baseline: `git stash` or branch from current state. Tag `pre-uniwind`.
2. Verify Uniwind compatibility with Expo SDK 55 + RN 0.83 + React 19 (per `package.json`). Spike on a throwaway folder if doubt remains.
3. Confirm font licenses (Inter ✓ OFL, Inter Tight ✓ OFL, Newsreader ✓ OFL, JetBrains Mono ✓ OFL — all good).
4. List the 40 icon names used across all design screens (scan `ui.jsx` `ICONS` map + grep `Icon name="` in screens-1..4) — this becomes the SVG checklist.
5. Inventory existing components that survive vs. get replaced:
   - **Survive (logic only)**: `useChatStream`, `chat-store`, `pending-attachments`, all of `src/api/`, `src/auth/`, `src/ws/`, `src/hooks/`, `src/util/`.
   - **Replaced**: every `.tsx` under `src/components/` and every screen under `app/`.
   - **Modified**: `src/config.ts` (theme constants → Uniwind tokens), `app/_layout.tsx` (root provider), `app/(app)/_layout.tsx` (tabs).

**Acceptance**
- Branch created, baseline snapshotted.
- Icon checklist written.
- Font availability confirmed.

---

## 3. Stage 1 — Foundations (single PR, no screen changes yet)

Goal: install Uniwind, drop in tokens, wire fonts, render a "hello world" screen against the theme system. Existing screens keep working unchanged (we don't touch them yet).

### 3.1 Install deps

```bash
cd frontend
pnpm dlx expo install \
  uniwind tailwindcss@4 \
  react-native-svg \
  @expo-google-fonts/inter \
  @expo-google-fonts/inter-tight \
  @expo-google-fonts/newsreader \
  @expo-google-fonts/jetbrains-mono \
  expo-font \
  @gorhom/bottom-sheet \
  react-native-gesture-handler \
  react-native-reanimated \
  react-native-markdown-display
```

`react-native-reanimated` is already pinned by Expo SDK 55. `gesture-handler` may need `babel-plugin` entry.

### 3.2 Metro + Babel config

`frontend/metro.config.js` (new):

```js
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
  extraThemes: [
    "paper-light", "paper-dark",
    "graphite-light", "graphite-dark",
    "plot-light", "plot-dark",
  ],
});
```

`frontend/babel.config.js` adds the reanimated plugin (last in plugins) — required by gesture-handler + bottom-sheet.

### 3.3 `global.css` at frontend root

Defines all 6 themes via `@variant` blocks. Token names mirror tailwind.config.js from the handoff (bg, surface, sunken, line, line-soft, chip, ink, ink-2, ink-3, accent, accent-bg, positive, warning, danger). Plus type-scale custom utilities and font-family vars.

Skeleton:

```css
@import "tailwindcss";
@import "uniwind";

@theme {
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px; --radius-xl: 16px;
  --radius-2xl: 20px; --radius-3xl: 28px;
  --font-display: "Inter Tight", "Inter", system-ui, sans-serif;
  --font-body: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", Menlo, monospace;
}

@layer theme {
  :root {
    @variant graphite-light {
      --color-bg: #F7F8FA; --color-surface: #FFFFFF; --color-sunken: #EEF0F4;
      --color-line: #E1E4EA; --color-line-soft: #ECEEF2; --color-chip: #EEF0F4;
      --color-ink: #0E1116; --color-ink-2: #3A4252; --color-ink-3: #7A8294;
      --color-accent: #4F46E5; --color-accent-bg: #EEF0FF;
      --color-positive: #197A4F; --color-warning: #A66A00; --color-danger: #C2342B;
    }
    @variant graphite-dark { /* …per theme.ts… */ }
    @variant paper-light { /* …per theme.ts… */ }
    @variant paper-dark { /* …per theme.ts… */ }
    @variant plot-light { /* …per theme.ts… */ }
    @variant plot-dark { /* …per theme.ts… */ }
  }
}
```

Source palettes verbatim from `design_handoff_hermes/theme.ts`. Custom font-family per palette is set at the `<View>` level in `ThemeProvider` (Newsreader for Plot display, etc.) since `@variant` doesn't support per-theme font-family overrides cleanly.

### 3.4 Type-scale utilities

Tailwind v4's `text-*` doesn't natively support our 10-step scale (`display`, `h1`, `h2`, `h3`, `body-lg`, `body`, `label`, `caption`, `micro`, `mono`). Define via `@utility`:

```css
@utility text-display { font-size: 32px; line-height: 36px; letter-spacing: -0.6px; font-weight: 600; }
@utility text-h1      { font-size: 26px; line-height: 32px; letter-spacing: -0.4px; font-weight: 600; }
/* …rest per tailwind.config.js… */
```

### 3.5 Font loading

`frontend/src/theme/fonts.ts`:

```ts
import {
  useFonts as useInter,
  Inter_400Regular, Inter_500Medium, Inter_600SemiBold,
} from "@expo-google-fonts/inter";
import { InterTight_500Medium, InterTight_600SemiBold } from "@expo-google-fonts/inter-tight";
import { Newsreader_400Regular, Newsreader_600SemiBold } from "@expo-google-fonts/newsreader";
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from "@expo-google-fonts/jetbrains-mono";

export function useAppFonts() {
  return useInter({
    Inter_400Regular, Inter_500Medium, Inter_600SemiBold,
    InterTight_500Medium, InterTight_600SemiBold,
    Newsreader_400Regular, Newsreader_600SemiBold,
    JetBrainsMono_400Regular, JetBrainsMono_500Medium,
  });
}
```

The hook returns `[loaded, error]`. Root layout shows splash until loaded.

### 3.6 Theme provider (Uniwind-flavored)

`frontend/src/theme/ThemeProvider.tsx`:

- Reads `variant` (`paper`/`graphite`/`plot`) and `mode` (`light`/`dark`) from AsyncStorage. Defaults to `graphite`/`light` per handoff.
- Computes Uniwind theme name = `${variant}-${mode}`.
- Calls `Uniwind.setTheme(name)` on mount and on change.
- Exposes `useTheme()` hook returning `{ variant, mode, density, fontOverride, set… }`.
- Persists changes back.

Density (compact / comfortable) lives in the same provider since it affects only ListRow height + section gaps and is read by components, not Uniwind classNames.

### 3.7 Root wiring

- `app/_layout.tsx`: load fonts, mount ThemeProvider, mount QueryClientProvider, mount GestureHandlerRootView, mount BottomSheetModalProvider, mount AuthGate, return Stack.
- Import `./global.css` at top of `app/_layout.tsx`.

### 3.8 Sanity check screen

Add a temporary debug screen `app/__theme.tsx` showing every color swatch, every type kind, every density, with a button row that cycles all 6 themes. **Do not delete until Stage 6** — used as visual regression check while screens migrate.

### Stage 1 acceptance

- `pnpm typecheck` clean.
- `pnpm prebuild && pnpm ios` builds.
- App boots, fonts loaded, debug theme screen renders all 6 palettes correctly.
- Existing screens still work (haven't been touched).

---

## 4. Stage 2 — Component library (single PR)

Goal: build all RN equivalents of `design/ui.jsx` so screen migration in Stages 4+ is just composition.

### 4.1 Component checklist (1:1 with `design/ui.jsx`)

Every component reads `useTheme()` for density and reads tokens via Tailwind classNames.

| New file | Source | Notes |
|---|---|---|
| `src/components/Stack.tsx` | `Stack` | flexCol, gap |
| `src/components/Row.tsx` | `Row` | flexRow, gap, align, justify |
| `src/components/Text.tsx` | `Text` | `kind` prop (display/h1…mono); maps to type-scale utilities |
| `src/components/Icon.tsx` | `Icon` + `ICONS` | `react-native-svg`. Port all 40 paths verbatim |
| `src/components/Button.tsx` | `Button` | 5 kinds × 3 sizes. Pressable + Tailwind variants |
| `src/components/Chip.tsx` | `Chip` | active/inactive |
| `src/components/Toggle.tsx` | `Toggle` | custom Pressable, animated thumb (Reanimated) |
| `src/components/Field.tsx` | `Field` | label + hint + error wrapping |
| `src/components/Input.tsx` | `Input` | TextInput + leftIcon + right slot, focus border |
| `src/components/ListGroup.tsx` | `ListGroup` | rounded card with header + dividers |
| `src/components/ListRow.tsx` | `ListRow` | icon tile + title/subtitle/detail/right/chevron |
| `src/components/NavBar.tsx` | `NavBar` | large + compact variants, leading/trailing slots |
| `src/components/NavIcon.tsx` | `NavIcon` | 36px square, badge dot |
| `src/components/StatusDot.tsx` | `StatusDot` | online/connecting/offline/idle |
| `src/components/StatusPill.tsx` | `StatusPill` | dot + label |
| `src/components/Section.tsx` | `Section` | uppercase eyebrow + action slot |
| `src/components/EmptyState.tsx` | `EmptyState` | icon tile + title + body + action |
| `src/components/SegControl.tsx` | `SegControl` | iOS-style 2/3 button toggle group |
| `src/components/ProgressBar.tsx` | `ProgressBar` | thin track + fill |
| `src/components/MonoBlock.tsx` | `MonoBlock` | preformatted mono code box |
| `src/components/HermesMark.tsx` | `HermesMark` | the SVG wordmark |
| `src/components/Sheet.tsx` | `Sheet` (custom) | wrap `@gorhom/bottom-sheet` with our handle styling |
| `src/components/Toast.tsx` | new | minimal animated `View`, top-anchored |
| `src/components/PhoneSafeArea.tsx` | `PhoneScreen` | wraps `SafeAreaView` + flex column + bg |

### 4.2 Icon set

40 SVG paths from `design/ui.jsx` `ICONS` map: `search, plus, close, check, chevR, chevL, chevD, chevU, send, attach, more, moreV, bell, clock, cog, user, key, shield, bolt, globe, doc, image, mic, trash, edit, archive, pause, play, refresh, flame, filter, eye, eyeOff, copy, share, download, upload, database, link, terminal, spark, flow, toggle, shieldCheck, hash`.

Single `Icon` component takes `name` and `size`, looks up the path. All paths render through `react-native-svg`'s `<Path>` with `stroke={currentColor} strokeWidth={1.6}` to match design.

### 4.3 Storybook (or equivalent)

Add a single `app/__components.tsx` debug screen showing one of every component in every variant. Used during dev + visual regression. Removed at Stage 6.

### Stage 2 acceptance

- `pnpm typecheck` clean.
- `__components` debug screen renders correctly across all 6 themes (toggle via debug screen from Stage 1).
- No business-logic regressions (existing screens still use the *old* components — they coexist).

---

## 5. Stage 3 — Navigation shell

Goal: replace flat stack with bottom tabs + per-tab nested stacks per `design/app.jsx`.

### 5.1 Tabs

Three tabs: **Chats** / **Cron** / **Settings**. Tab bar appears only on tab roots; on detail pushes it hides (standard iOS pattern).

`app/(app)/_layout.tsx` becomes:

```tsx
<Tabs screenOptions={{ tabBar: CustomTabBar }}>
  <Tabs.Screen name="(chats)" options={{ title: "Chats" }} />
  <Tabs.Screen name="(cron)" options={{ title: "Cron" }} />
  <Tabs.Screen name="(settings)" options={{ title: "Settings" }} />
</Tabs>
```

`CustomTabBar` is a custom component matching the prototype's bottom-bar design (icons + labels, accent on active, hides on push depth > 0 by checking router state).

### 5.2 Folder restructure

From flat:
```
app/(app)/
  index.tsx       ← session list
  chat/[id].tsx
  cron/...
  settings.tsx
  settings/vision.tsx
```

To nested:
```
app/(app)/
  _layout.tsx                        ← Tabs
  (chats)/
    _layout.tsx                      ← Stack
    index.tsx                        ← session list
    chat/[id].tsx
    search.tsx                       ← new
  (cron)/
    _layout.tsx                      ← Stack
    index.tsx                        ← cron list
    [jobId]/
      index.tsx                      ← detail
      output/[outputId].tsx
      edit.tsx                       ← new
    new.tsx                          ← new
  (settings)/
    _layout.tsx                      ← Stack
    index.tsx                        ← settings hub
    model.tsx                        ← new
    vision.tsx
    aux.tsx                          ← new
    keys.tsx                         ← new
    notifications.tsx                ← new
    storage.tsx                      ← new
    diagnostics.tsx                  ← new
    account.tsx                      ← new
    usage.tsx                        ← new
    toolsets.tsx                     ← new
    skills.tsx                       ← new
    about.tsx                        ← new
    appearance.tsx                   ← new (theme variant + density picker)
```

### 5.3 Header strategy

Each screen renders our own `<NavBar>` from Stage 2. Disable Expo Router's default header in each `_layout.tsx` (`headerShown: false`).

### Stage 3 acceptance

- Tabs render on tab roots, hide on detail push.
- Existing screens still work but render under new shell.
- Auth redirect logic (login on no token) still fires.
- Type-safe routes work (`router.push("/cron/abc")`).

---

## 6. Stages 4–10 — Screen migration (iterative, one stage per area)

Each migration stage = one feature area, one PR, one visual check pass. Order matches handoff `§Suggested implementation order` but adapted to our existing-app reality:

### Stage 4 — Settings hub + 13 sub-screens

Why first: validates `ListGroup` + `ListRow` + `Section` + `NavBar` + theming before touching the more complex chat / cron flows. Many of these don't exist yet in the app — net-new build.

| # | Screen | Source | Backend |
|---|---|---|---|
| 1 | Settings index | `screens-3.jsx::SettingsIndex` | none |
| 2 | Appearance | (handoff §3.3 — variant + density picker) | local store |
| 3 | Main model | `screens-3.jsx::ModelPicker` | new `GET /settings/model`, `PUT /settings/model` (proxy `/api/config`) |
| 4 | Vision | `screens-3.jsx::VisionPicker` | already wired |
| 5 | Other aux | `screens-3.jsx::AuxModels` | new endpoints per task: web_extract / compression / session_search / skills_hub / approval |
| 6 | Provider keys | `screens-3.jsx::Keys` | new `GET /settings/keys`, `PUT /settings/keys/:id` (proxy `/api/env`) |
| 7 | Notifications | `screens-3.jsx::Notifications` | local + push registration (already wired) |
| 8 | Storage | `screens-3.jsx::Storage` | new `GET /storage/usage` |
| 9 | Diagnostics | `screens-3.jsx::Diagnostics` | proxy `GET /logs` (already wired) |
| 10 | Account | `screens-3.jsx::Account` | new `POST /auth/change-password`, `POST /auth/sessions/revoke` |
| 11 | Usage | `screens-3.jsx::Usage` | proxy `GET /analytics/usage` (already wired) |
| 12 | Toolsets | `screens-3.jsx::Toolsets` | proxy `GET /tools/toolsets` |
| 13 | Skills | `screens-3.jsx::Skills` | proxy `GET /skills` |
| 14 | About | `screens-3.jsx::About` | proxy `GET /api/status` for versions |

**Backend deltas this stage**: ~5 new gateway routes (model picker, aux model factory, keys, storage usage, account change-password). Document them in `HERMES_CONTRACT.md` as needed.

**Acceptance**: every settings row navigates and renders matching the prototype. Persistence works for the ones that own state (theme, density, prefs).

### Stage 5 — Login + onboarding (5 screens)

| # | Screen | Source | Notes |
|---|---|---|---|
| 1 | Login | `screens-1.jsx::LoginScreen` | server URL field added (currently env-only) |
| 2 | Onboarding 1: welcome | `screens-4.jsx::Onboarding1` | new |
| 3 | Onboarding 2: connect | `screens-4.jsx::Onboarding2` | re-uses login form |
| 4 | Onboarding 3: pick model | `screens-4.jsx::Onboarding3` | embeds model picker |
| 5 | Onboarding 4: notifications | `screens-4.jsx::Onboarding4` | reuses Stage 4 notification toggle |

**Acceptance**: fresh install runs through onboarding, ends at sessions list. Re-login skips onboarding.

### Stage 6 — Sessions + chat (4 screens + 3 modals)

| # | Screen | Source | Backend |
|---|---|---|---|
| 1 | Session list | `screens-1.jsx::SessionList` | already wired |
| 2 | Chat | `screens-1.jsx::ChatScreen` + `Message` | already wired (rich history from chat_history) |
| 3 | Search | `screens-2.jsx::SearchScreen` | already wired (`/sessions/search`) |
| 4 | Tool detail (push) | `screens-4.jsx::ToolDetail` | renders chat-history `tool.call` payload |
| 5 | Approval modal (sheet) | `screens-4.jsx::ApprovalModal` | already wired |
| 6 | Image lightbox (modal) | `screens-2.jsx::ImageLightbox` | new |

**Special handling**:
- Replace current regex Markdown.tsx with `react-native-markdown-display`.
- Composer matches design exactly (rounded pill bg, plus on left, send on right).
- Tool cards collapse-on-tap → push to Tool detail.
- Approval inline card stays; modal variant fires when push notification opens an approval.

**Remove debug screens** (`__theme`, `__components`) at end of this stage — visual confidence achieved across the heaviest flow.

**Acceptance**: full chat round-trip works against live Hermes. Cold-load history renders all kinds (user, assistant, tool, reasoning, approval, error). Send + stream + approve a real destructive command.

### Stage 7 — Cron (4 screens)

| # | Screen | Source | Backend |
|---|---|---|---|
| 1 | Cron list | `screens-2.jsx::CronList` | already wired |
| 2 | Cron detail | `screens-2.jsx::CronDetail` | already wired |
| 3 | Output viewer | `screens-2.jsx::OutputViewer` | already wired |
| 4 | New / edit job | `screens-2.jsx::CronEditor` | already proxied |

**Special handling**: cron-expression builder UI (chips for Hourly / Daily / Weekdays / Custom; Custom reveals mono input). Schedule preview ("next 3 runs: …") computed client-side via a `cron-parser` lib.

**Acceptance**: create cron via the editor, see it land in `~/.hermes/cron/jobs.json`, get a push notification when it runs, tap → output viewer.

### Stage 8 — Polish

- Skeletons for first paint of every list (matching row dimensions).
- Pull-to-refresh accent-color spinner.
- Toast for server-side errors.
- Inline form validation.
- Long-press haptics (`expo-haptics`).
- Empty states for every list.
- Pinch-zoom on image lightbox.
- Bottom-sheet snap points.

Each is a small commit; defer or skip individually.

### Stage 9 — Theming polish

- Settings → Appearance: variant picker (3 cards), mode toggle (light/dark/system), density toggle (compact/comfortable).
- Persist to AsyncStorage.
- Animated transition on variant switch (cross-fade root view, 220ms).
- Verify all 6 palettes look correct on every screen.

### Stage 10 — QA + screenshots

- Walk every screen on iOS Simulator + a physical device for both palettes.
- Screenshot every screen vs. handoff prototype side-by-side; flag visual deltas.
- Fix the deltas.
- Final typecheck + lint + dev-client release build.

---

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Uniwind incompatibility with Expo SDK 55 / React 19 | Stage 0 spike on throwaway project before committing |
| Tailwind v4 + Expo build pipeline edge cases | Follow uniwind/metro recipe verbatim; keep `cssEntryFile` + `dtsFile` paths exact |
| Per-palette font swap (Plot uses Newsreader display) | Apply via `<Text className="font-display">` mapped to Tailwind's `--font-display` CSS var; vary the var per theme inside `@variant` blocks |
| Bottom-sheet + reanimated + gesture-handler version conflicts | Pin all three to versions Expo SDK 55 ships; avoid manual reanimated upgrades |
| Re-rendering perf on theme switch (every view re-renders) | Use `Uniwind.setTheme()` (it's optimized for batched re-render) — do not change React keys on switch |
| Existing screens regressing during migration | Each migration stage replaces only that area's screens; old components stay until their consumers are gone |
| Icon path drift between web SVG and react-native-svg | Single `Icon` component; verify on debug screen across all 40 icons |
| Density "comfortable" = 56pt rows breaks long iPad tablet layouts | Tablet/landscape out of scope per handoff; defer to a later phase |

---

## 8. Rollback plan

- Stage 0 creates branch `pre-uniwind` snapshot. If we abandon mid-migration, `git checkout pre-uniwind` restores.
- Each stage is a separate branch + PR. Reverting a single stage doesn't undo earlier stages.
- Stages 1–3 are foundational; Stage 4+ are independently revertable.

---

## 9. Time estimate (rough, single dev)

| Stage | Estimate |
|---|---|
| 0 — Pre-flight | 1–2 hr |
| 1 — Foundations | 4–6 hr |
| 2 — Component library | 8–12 hr |
| 3 — Navigation shell | 3–4 hr |
| 4 — Settings (14 screens, ~5 net-new) | 12–16 hr |
| 5 — Auth + onboarding | 4–6 hr |
| 6 — Sessions + chat + modals | 10–14 hr |
| 7 — Cron (incl. editor) | 6–8 hr |
| 8 — Polish | 4–6 hr |
| 9 — Theming polish | 2–3 hr |
| 10 — QA pass | 4–6 hr |
| **Total** | **58–83 hr** |

Parallelization possible: Stages 4 and 6 are independent and could run in parallel after Stages 1–3 land.

---

## 10. Deliverables checklist (running)

After each stage we expect these artifacts to exist:

- [ ] Stage 0 — `pre-uniwind` git tag, icon checklist, font confirmation
- [ ] Stage 1 — `global.css`, `metro.config.js`, `theme/ThemeProvider.tsx`, `theme/fonts.ts`, font registration in root, debug `__theme.tsx` screen
- [ ] Stage 2 — every component in `src/components/` per §4.1 table, debug `__components.tsx` screen
- [ ] Stage 3 — tabs at `app/(app)/_layout.tsx`, three nested stacks, custom tab bar
- [ ] Stage 4 — 14 settings screens, ~5 new gateway routes
- [ ] Stage 5 — Login + 4 onboarding screens, server-URL editor, first-run gating
- [ ] Stage 6 — Sessions + Chat + Search + Tool detail + Approval modal + Lightbox
- [ ] Stage 7 — Cron list / detail / output / editor
- [ ] Stage 8 — skeletons, toasts, haptics, empty states wired
- [ ] Stage 9 — Appearance screen, variant/mode/density persistence
- [ ] Stage 10 — final visual diff vs prototype, dev-client TestFlight build

---

## 11. Decision points before we start

These need user sign-off:

1. **Branch model**: long-lived `feat/uniwind-rebuild` branch and merge stages into it via sub-PRs, or merge each stage to main as it ships? (Recommendation: long-lived branch — main stays usable.)
2. **Variant default**: ship all three (Paper / Graphite / Plot) selectable per handoff §1, or pick one and delete the others? (Recommendation: ship all three; the picker is small.)
3. **Density default**: `comfortable` or `compact`? (Recommendation: `comfortable` — iOS Settings-app-like density.)
4. **iA Writer Quattro V**: skip and use JetBrains Mono fallback for Paper variant, or you'll provide the licensed `.ttf`? (Recommendation: skip.)
5. **Onboarding scope**: full 4 steps per handoff, or just login + notifications opt-in? (Recommendation: full 4 — tiny extra cost, much better first-run.)
6. **Existing chat history**: keep current rich-history backend as-is, or also extend to surface `tool.call` cards with the new design? (Recommendation: keep — chat-history backend already handles this; only renderer changes.)
7. **Backend route adds for Stage 4** (model picker / keys / storage usage / account password): commit to building these alongside the screens, or stub the screens until later? (Recommendation: build alongside — screens are a lot less useful as stubs.)

Answer these, then we execute Stage 0–1 immediately.
