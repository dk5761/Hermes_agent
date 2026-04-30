# Hermes Mobile App (Phase 3 MVP)

Expo React Native app talking to the Hermes mobile gateway over REST + WS.

## Stack

- Expo SDK 55, React 19, RN 0.83
- Expo Router (file-based)
- TanStack Query v5 (REST)
- Zustand v5 (auth + per-session chat state)
- Expo SecureStore (tokens)

## Setup

```sh
pnpm install
cp .env.example .env
# Edit .env and set EXPO_PUBLIC_API_URL / EXPO_PUBLIC_WS_URL to your gateway.
# For physical-device testing on LAN, set them to http://<lan-ip>:8080 and ws://<lan-ip>:8080.
pnpm typecheck
pnpm start
```

Then scan the QR with Expo Go on your phone, or press `i` / `a` in the CLI for the iOS / Android simulator.

## Layout

- `app/` — expo-router routes:
  - `(auth)/login.tsx`
  - `(app)/index.tsx` (session list)
  - `(app)/chat/[id].tsx` (chat + WS streaming)
  - `(app)/settings.tsx`
- `src/api/` — REST client + endpoint wrappers
- `src/auth/` — Zustand auth store + SecureStore wrapper + redirect hook
- `src/ws/` — `GatewayWsClient` (framework-agnostic) + `use-chat-stream` hook
- `src/state/` — chat-store with the message-deltas reducer
- `src/components/` — primitives (Screen, Button, MessageBubble, ToolCallCard, ApprovalCard, ConnectionStatus)

## Phase 3 scope

Login, session CRUD, text-only chat with streaming, tool/reasoning/approval rendering, WS auto-reconnect with `lastEventId` resume and `sync.required` handling.

Image uploads, cron, push, biometric unlock, theming, and TanStack Query AsyncStorage persistence are deferred to later phases.
