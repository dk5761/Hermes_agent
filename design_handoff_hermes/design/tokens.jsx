// Hermes Design System — tokens
// Modern utility direction. NativeWind/Tailwind-friendly: every token below
// has a parallel in tailwind.config.js theme.extend (see comment at bottom).
// Three aesthetic variants share the same primitives, only colors+type swap.

const HERMES = {
  // ─── 3 aesthetic variants ───────────────────────────────────────
  variants: {
    paper: {
      // A: Paper — IA Writer warmth, off-white, ink black, monospace meta
      name: 'Paper',
      light: {
        bg:     '#FAF8F4',  // warm paper
        surface:'#FFFFFF',
        sunken: '#F2EEE6',
        line:   '#E5DFD2',
        lineSoft:'#EFEAE0',
        ink:    '#1C1A17',
        ink2:   '#4A4640',
        ink3:   '#8A857A',
        accent: '#B85C2E',  // burnt sienna
        accentBg:'#F5E4D6',
        positive:'#3F7A4D',
        warning:'#A8761B',
        danger: '#B43A2E',
        chip:   '#EEE9DD',
      },
      dark: {
        bg:     '#161410',
        surface:'#1F1C17',
        sunken: '#0F0E0B',
        line:   '#2E2A23',
        lineSoft:'#26221C',
        ink:    '#F2EEE5',
        ink2:   '#B8B2A4',
        ink3:   '#7A7468',
        accent: '#E08A52',
        accentBg:'#3A2418',
        positive:'#7DB18A',
        warning:'#D6A65A',
        danger: '#E27666',
        chip:   '#2A2620',
      },
    },
    graphite: {
      // B: Graphite — Linear-ish cool neutrals, indigo accent
      name: 'Graphite',
      light: {
        bg:     '#F7F8FA',
        surface:'#FFFFFF',
        sunken: '#EEF0F4',
        line:   '#E1E4EA',
        lineSoft:'#ECEEF2',
        ink:    '#0E1116',
        ink2:   '#3A4252',
        ink3:   '#7A8294',
        accent: '#4F46E5',
        accentBg:'#EEF0FF',
        positive:'#197A4F',
        warning:'#A66A00',
        danger: '#C2342B',
        chip:   '#EEF0F4',
      },
      dark: {
        bg:     '#0B0D11',
        surface:'#14171D',
        sunken: '#070809',
        line:   '#222731',
        lineSoft:'#1A1E26',
        ink:    '#EEF1F6',
        ink2:   '#A8B0BF',
        ink3:   '#6A7388',
        accent: '#8B86FF',
        accentBg:'#1B1B40',
        positive:'#74D29A',
        warning:'#E6B25F',
        danger: '#F26B5E',
        chip:   '#1B1F27',
      },
    },
    plot: {
      // C: Plot — Editorial, serif display, paper-cream bg, plum accent
      name: 'Plot',
      light: {
        bg:     '#F4F1EA',
        surface:'#FFFDF7',
        sunken: '#EBE6DB',
        line:   '#D8D2C2',
        lineSoft:'#E4DFD0',
        ink:    '#15140F',
        ink2:   '#4D483C',
        ink3:   '#8A8474',
        accent: '#6B2E48',
        accentBg:'#F0DDE3',
        positive:'#3A6E4A',
        warning:'#8E6A1F',
        danger: '#A93128',
        chip:   '#EBE6DB',
      },
      dark: {
        bg:     '#13110D',
        surface:'#1C1914',
        sunken: '#0D0B08',
        line:   '#2E2A22',
        lineSoft:'#241F1A',
        ink:    '#F1ECDF',
        ink2:   '#B8B19E',
        ink3:   '#7C7665',
        accent: '#D88AA0',
        accentBg:'#3A1E2A',
        positive:'#80C190',
        warning:'#D8AE6E',
        danger: '#E27566',
        chip:   '#252119',
      },
    },
  },

  // ─── Type pairings ───────────────────────────────────────────
  // These are paired with variants by index but can be swapped via tweaks.
  fonts: {
    paper: {
      display: '"iA Writer Quattro V", "iA Writer Duo S", ui-monospace, SFMono-Regular, Menlo, monospace',
      body:    '"iA Writer Quattro V", "Söhne", -apple-system, system-ui, sans-serif',
      mono:    'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
    },
    graphite: {
      display: '"Inter Tight", -apple-system, system-ui, sans-serif',
      body:    '"Inter", -apple-system, system-ui, sans-serif',
      mono:    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
    plot: {
      display: '"Newsreader", "Source Serif Pro", Georgia, serif',
      body:    '"Söhne", -apple-system, system-ui, sans-serif',
      mono:    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    },
  },

  // ─── Spacing scale (matches Tailwind; in px) ─────────────────
  // 0,1,2,3,4,5,6,8,10,12,16,20 → 0,2,4,6,8,10,12,16,20,24,32,40
  space: { 0:0, 0.5:2, 1:4, 1.5:6, 2:8, 2.5:10, 3:12, 4:16, 5:20, 6:24, 8:32, 10:40, 12:48, 16:64 },

  // ─── Radii ───────────────────────────────────────────────────
  radius: { none:0, sm:4, md:8, lg:12, xl:16, '2xl':20, '3xl':28, full:9999 },

  // ─── Type scale ──────────────────────────────────────────────
  // (size, lineHeight, weight, tracking)
  type: {
    display:   { size: 32, lh: 36, weight: 600, tracking: -0.6 },
    h1:        { size: 26, lh: 32, weight: 600, tracking: -0.4 },
    h2:        { size: 20, lh: 26, weight: 600, tracking: -0.3 },
    h3:        { size: 17, lh: 22, weight: 600, tracking: -0.2 },
    body:      { size: 15, lh: 22, weight: 400, tracking: -0.1 },
    bodyLg:    { size: 17, lh: 24, weight: 400, tracking: -0.2 },
    label:     { size: 13, lh: 18, weight: 500, tracking: 0 },
    caption:   { size: 12, lh: 16, weight: 400, tracking: 0 },
    micro:     { size: 11, lh: 14, weight: 500, tracking: 0.4 },
    mono:      { size: 13, lh: 18, weight: 400, tracking: 0 },
  },

  // ─── Density (compact/comfortable) ────────────────────────────
  density: {
    compact:     { rowH: 44, listGap: 0,  sectionGap: 22, cellPadY: 10, cellPadX: 14 },
    comfortable: { rowH: 56, listGap: 1,  sectionGap: 30, cellPadY: 14, cellPadX: 16 },
  },

  // ─── Shadows (very subtle) ───────────────────────────────────
  shadow: {
    sm: '0 1px 2px rgba(0,0,0,0.04)',
    md: '0 1px 3px rgba(0,0,0,0.06), 0 4px 12px rgba(0,0,0,0.04)',
    lg: '0 8px 32px rgba(0,0,0,0.10)',
  },

  // ─── Motion ───────────────────────────────────────────────────
  motion: {
    fast:   '120ms cubic-bezier(0.2,0,0,1)',
    base:   '180ms cubic-bezier(0.2,0,0,1)',
    slow:   '280ms cubic-bezier(0.2,0,0,1)',
  },
};

// Helper: resolve a theme object given variant + mode + font override
function resolveTheme(variant = 'paper', mode = 'light', fontOverride = null) {
  const v = HERMES.variants[variant];
  const fonts = HERMES.fonts[fontOverride || variant];
  return { ...v[mode], variant, mode, fonts, name: v.name };
}

window.HERMES = HERMES;
window.resolveTheme = resolveTheme;

/* NativeWind / Tailwind config equivalent (for the engineer):

theme.extend = {
  colors: {
    bg: 'var(--bg)', surface: 'var(--surface)', sunken: 'var(--sunken)',
    line: 'var(--line)', 'line-soft': 'var(--line-soft)',
    ink: 'var(--ink)', 'ink-2': 'var(--ink-2)', 'ink-3': 'var(--ink-3)',
    accent: 'var(--accent)', 'accent-bg': 'var(--accent-bg)',
    positive: 'var(--positive)', warning: 'var(--warning)', danger: 'var(--danger)',
    chip: 'var(--chip)',
  },
  fontFamily: { display: 'var(--font-display)', body: 'var(--font-body)', mono: 'var(--font-mono)' },
  borderRadius: { sm:4, md:8, lg:12, xl:16, '2xl':20, '3xl':28 },
  spacing: { 0.5:2, 1:4, 1.5:6, 2:8, 2.5:10, 3:12, 4:16, 5:20, 6:24, 8:32, 10:40, 12:48, 16:64 },
};

Each screen is a React Native flex column with these tokens.
*/
