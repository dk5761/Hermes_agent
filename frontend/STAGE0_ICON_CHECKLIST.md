# Icon set checklist (Stage 0)

Source: `design_handoff_hermes/design/ui.jsx` `ICONS` map.
Target: `frontend/src/components/Icon.tsx` (Stage 2) using `react-native-svg`.

All paths render with `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth=1.6`, `strokeLinecap="round"`, `strokeLinejoin="round"`.

## Full set (40)

| Name | SVG path data |
|---|---|
| search | `M21 21l-4.3-4.3M11 19a8 8 0 110-16 8 8 0 010 16z` |
| plus | `M12 5v14M5 12h14` |
| close | `M6 6l12 12M18 6L6 18` |
| check | `M5 12l5 5L20 7` |
| chevR | `M9 6l6 6-6 6` |
| chevL | `M15 6l-6 6 6 6` |
| chevD | `M6 9l6 6 6-6` |
| chevU | `M18 15l-6-6-6 6` |
| send | `M3 11l18-8-8 18-2-8-8-2z` |
| attach | `M21 11l-9 9a5 5 0 11-7-7l9-9a3 3 0 014 4l-9 9a1 1 0 01-1-1l8-8` |
| more | `M5 12h.01M12 12h.01M19 12h.01` |
| moreV | `M12 5h.01M12 12h.01M12 19h.01` |
| bell | `M18 16v-5a6 6 0 10-12 0v5l-2 2h16l-2-2zM10 21h4` |
| clock | `M12 7v5l3 2M12 21a9 9 0 110-18 9 9 0 010 18z` |
| cog | `M12 9a3 3 0 100 6 3 3 0 000-6zm9 3a9 9 0 01-.6 3l2 1.5-2 3.5-2.4-1a9 9 0 01-2.6 1.5L13 23h-2l-.4-2.5a9 9 0 01-2.6-1.5l-2.4 1-2-3.5L5.6 15a9 9 0 010-6L3.6 7.5l2-3.5 2.4 1A9 9 0 018.6 3.5L11 1h2l.4 2.5a9 9 0 012.6 1.5l2.4-1 2 3.5L18.4 9c.4 1 .6 2 .6 3z` |
| user | `M16 11a4 4 0 11-8 0 4 4 0 018 0zM4 21a8 8 0 0116 0` |
| key | `M14 7a4 4 0 11-3.5 6L7 17H4v-3l7-7z` |
| shield | `M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z` |
| bolt | `M13 2L4 14h7l-1 8 9-12h-7l1-8z` |
| globe | `M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a13 13 0 010 18M12 3a13 13 0 000 18` |
| doc | `M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6zM14 3v6h6` |
| image | `M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6` |
| mic | `M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3` |
| trash | `M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M6 6l1 14a2 2 0 002 2h6a2 2 0 002-2l1-14` |
| edit | `M4 20h4l11-11-4-4L4 16v4zM14 5l4 4` |
| archive | `M3 5h18v4H3zM5 9v11h14V9M10 13h4` |
| pause | `M6 4h4v16H6zM14 4h4v16h-4z` |
| play | `M6 4l14 8-14 8V4z` |
| refresh | `M4 4v6h6M20 20v-6h-6M4 10a9 9 0 0115-3M20 14a9 9 0 01-15 3` |
| flame | `M12 2c1 4 5 5 5 10a5 5 0 11-10 0c0-3 2-4 2-7 1 1 2 1 3-3z` |
| filter | `M4 4h16l-6 8v6l-4 2v-8L4 4z` |
| eye | `M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z` |
| eyeOff | `M3 3l18 18M10 6a10 10 0 0112 6 12 12 0 01-2 2.5M14 14a3 3 0 11-4-4M4 8a12 12 0 00-2 4s4 7 10 7c2 0 3-.5 4.5-1.2` |
| copy | `M8 8h12v12H8zM4 4h12v4M4 4v12h4` |
| share | `M4 12v8h16v-8M16 6l-4-4-4 4M12 2v14` |
| download | `M12 3v14m-5-5l5 5 5-5M4 21h16` |
| upload | `M12 21V7m-5 5l5-5 5 5M4 3h16` |
| database | `M4 6c0-2 4-3 8-3s8 1 8 3-4 3-8 3-8-1-8-3zM4 6v6c0 2 4 3 8 3s8-1 8-3V6M4 12v6c0 2 4 3 8 3s8-1 8-3v-6` |
| link | `M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1` |
| terminal | `M4 17l6-6-6-6M12 19h8` |
| spark | `M12 2v4M12 18v4M4 12H2M22 12h-2M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3` |
| flow | `M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6zM10 7h4M7 10v4M17 10v4M10 17h4` |
| toggle | `M8 7h8a5 5 0 010 10H8a5 5 0 010-10zM8 17a5 5 0 100-10 5 5 0 000 10z` |
| shieldCheck | `M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4` |
| hash | `M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18` |

## Implementation note

Single `Icon` component splits the path string on `M` and renders one `<Path>` per segment. Verbatim port from `ui.jsx::Icon`. SVG color follows `currentColor` so we can drive it via `style={{ color }}` from Tailwind.

## Currently-referenced subset (active in screens-1..4)

Verified via grep:

```
bell, check, chevL, chevR, clock, close, cog, copy, edit, more, plus,
search, send, share, shield, shieldCheck, spark
```

Plus Icon names referenced inside lists: `attach, doc, hash, key, image,
mic, terminal, flow, bolt, database, eye, lock, refresh, link, trash,
play, pause, archive, user, globe, filter`.

Build all 40; cost is negligible.
