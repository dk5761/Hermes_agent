/**
 * Hermes — NativeWind / Tailwind config
 *
 * Drop into a React Native + NativeWind project. Colors are wired to CSS
 * variables which the ThemeProvider (theme.ts) sets at runtime, so the same
 * components re-skin instantly when the user toggles variant or light/dark.
 *
 * If you'd rather hard-code one variant: replace `var(--bg)` etc. with the
 * literal hex values from `theme.ts` for the variant you want to ship.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      colors: {
        bg:        'var(--bg)',
        surface:   'var(--surface)',
        sunken:    'var(--sunken)',
        line:      'var(--line)',
        'line-soft':'var(--line-soft)',
        chip:      'var(--chip)',
        ink: {
          DEFAULT: 'var(--ink)',
          2:       'var(--ink-2)',
          3:       'var(--ink-3)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          bg:      'var(--accent-bg)',
        },
        positive: 'var(--positive)',
        warning:  'var(--warning)',
        danger:   'var(--danger)',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        body:    ['var(--font-body)'],
        mono:    ['var(--font-mono)'],
      },
      fontSize: {
        // [size, { lineHeight, letterSpacing, fontWeight }]
        display: ['32px', { lineHeight: '36px', letterSpacing: '-0.6px', fontWeight: '600' }],
        h1:      ['26px', { lineHeight: '32px', letterSpacing: '-0.4px', fontWeight: '600' }],
        h2:      ['20px', { lineHeight: '26px', letterSpacing: '-0.3px', fontWeight: '600' }],
        h3:      ['17px', { lineHeight: '22px', letterSpacing: '-0.2px', fontWeight: '600' }],
        'body-lg':['17px', { lineHeight: '24px', letterSpacing: '-0.2px', fontWeight: '400' }],
        body:    ['15px', { lineHeight: '22px', letterSpacing: '-0.1px', fontWeight: '400' }],
        label:   ['13px', { lineHeight: '18px', letterSpacing: '0px',    fontWeight: '500' }],
        caption: ['12px', { lineHeight: '16px', letterSpacing: '0px',    fontWeight: '400' }],
        micro:   ['11px', { lineHeight: '14px', letterSpacing: '0.4px',  fontWeight: '500' }],
        mono:    ['13px', { lineHeight: '18px', letterSpacing: '0px',    fontWeight: '400' }],
      },
      borderRadius: {
        sm: '4px', md: '8px', lg: '12px', xl: '16px', '2xl': '20px', '3xl': '28px',
      },
      spacing: {
        0.5: '2px',  1: '4px',  1.5: '6px',  2: '8px',  2.5: '10px',
        3: '12px',  4: '16px',  5: '20px',  6: '24px',
        8: '32px',  10: '40px', 12: '48px', 16: '64px',
      },
    },
  },
  plugins: [],
};
