// Hermes UI primitives — small, composable, tokens-driven
// Exposes: Stack, Row, Text, Icon, Button, Chip, Toggle, Field, ListGroup,
// ListRow, NavBar, TabBar, Section, EmptyState, StatusDot, Avatar, Sheet,
// SegControl, ProgressBar, MonoBlock

const { useState } = React;

// ─── Stack / Row ────────────────────────────────────────────────
function Stack({ gap = 0, children, style, ...rest }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }} {...rest}>{children}</div>;
}
function Row({ gap = 0, align = 'center', justify = 'flex-start', children, style, ...rest }) {
  return <div style={{ display: 'flex', flexDirection: 'row', alignItems: align, justifyContent: justify, gap, ...style }} {...rest}>{children}</div>;
}

// ─── Text ──────────────────────────────────────────────────────
function Text({ kind = 'body', mono = false, color, children, style = {}, ...rest }) {
  const t = window.HERMES.type[kind] || window.HERMES.type.body;
  const theme = window.__theme;
  return (
    <span style={{
      fontFamily: mono ? theme.fonts.mono : (kind === 'display' || kind === 'h1' ? theme.fonts.display : theme.fonts.body),
      fontSize: t.size, lineHeight: `${t.lh}px`, fontWeight: t.weight, letterSpacing: t.tracking,
      color: color || theme.ink,
      ...style,
    }} {...rest}>{children}</span>
  );
}

// ─── Icon ──────────────────────────────────────────────────────
// Tiny line-icon set. 1.5px stroke, currentColor.
const ICONS = {
  search: 'M21 21l-4.3-4.3M11 19a8 8 0 110-16 8 8 0 010 16z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  chevR: 'M9 6l6 6-6 6',
  chevL: 'M15 6l-6 6 6 6',
  chevD: 'M6 9l6 6 6-6',
  chevU: 'M18 15l-6-6-6 6',
  send: 'M3 11l18-8-8 18-2-8-8-2z',
  attach: 'M21 11l-9 9a5 5 0 11-7-7l9-9a3 3 0 014 4l-9 9a1 1 0 01-1-1l8-8',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  moreV: 'M12 5h.01M12 12h.01M12 19h.01',
  bell: 'M18 16v-5a6 6 0 10-12 0v5l-2 2h16l-2-2zM10 21h4',
  clock: 'M12 7v5l3 2M12 21a9 9 0 110-18 9 9 0 010 18z',
  cog: 'M12 9a3 3 0 100 6 3 3 0 000-6zm9 3a9 9 0 01-.6 3l2 1.5-2 3.5-2.4-1a9 9 0 01-2.6 1.5L13 23h-2l-.4-2.5a9 9 0 01-2.6-1.5l-2.4 1-2-3.5L5.6 15a9 9 0 010-6L3.6 7.5l2-3.5 2.4 1A9 9 0 018.6 3.5L11 1h2l.4 2.5a9 9 0 012.6 1.5l2.4-1 2 3.5L18.4 9c.4 1 .6 2 .6 3z',
  user: 'M16 11a4 4 0 11-8 0 4 4 0 018 0zM4 21a8 8 0 0116 0',
  key: 'M14 7a4 4 0 11-3.5 6L7 17H4v-3l7-7z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a13 13 0 010 18M12 3a13 13 0 000 18',
  doc: 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9l-6-6zM14 3v6h6',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6',
  mic: 'M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3',
  trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M6 6l1 14a2 2 0 002 2h6a2 2 0 002-2l1-14',
  edit: 'M4 20h4l11-11-4-4L4 16v4zM14 5l4 4',
  archive: 'M3 5h18v4H3zM5 9v11h14V9M10 13h4',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  play: 'M6 4l14 8-14 8V4z',
  refresh: 'M4 4v6h6M20 20v-6h-6M4 10a9 9 0 0115-3M20 14a9 9 0 01-15 3',
  flame: 'M12 2c1 4 5 5 5 10a5 5 0 11-10 0c0-3 2-4 2-7 1 1 2 1 3-3z',
  filter: 'M4 4h16l-6 8v6l-4 2v-8L4 4z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 100 6 3 3 0 000-6z',
  eyeOff: 'M3 3l18 18M10 6a10 10 0 0112 6 12 12 0 01-2 2.5M14 14a3 3 0 11-4-4M4 8a12 12 0 00-2 4s4 7 10 7c2 0 3-.5 4.5-1.2',
  copy: 'M8 8h12v12H8zM4 4h12v4M4 4v12h4',
  share: 'M4 12v8h16v-8M16 6l-4-4-4 4M12 2v14',
  download: 'M12 3v14m-5-5l5 5 5-5M4 21h16',
  upload: 'M12 21V7m-5 5l5-5 5 5M4 3h16',
  database: 'M4 6c0-2 4-3 8-3s8 1 8 3-4 3-8 3-8-1-8-3zM4 6v6c0 2 4 3 8 3s8-1 8-3V6M4 12v6c0 2 4 3 8 3s8-1 8-3v-6',
  link: 'M10 14a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 10a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  spark: 'M12 2v4M12 18v4M4 12H2M22 12h-2M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3',
  flow: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6zM10 7h4M7 10v4M17 10v4M10 17h4',
  toggle: 'M8 7h8a5 5 0 010 10H8a5 5 0 010-10zM8 17a5 5 0 100-10 5 5 0 000 10z',
  shieldCheck: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM9 12l2 2 4-4',
  hash: 'M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18',
};

function Icon({ name, size = 20, color, stroke = 1.6, style }) {
  const d = ICONS[name] || ICONS.more;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color || 'currentColor'} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }}>
      {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  );
}

// ─── Button ────────────────────────────────────────────────────
function Button({ kind = 'primary', size = 'md', leftIcon, rightIcon, children, onClick, full, style }) {
  const theme = window.__theme;
  const sizes = {
    sm: { h: 32, px: 12, fs: 13, gap: 6, r: 8 },
    md: { h: 40, px: 14, fs: 15, gap: 8, r: 10 },
    lg: { h: 48, px: 18, fs: 16, gap: 10, r: 12 },
  }[size];
  const kinds = {
    primary: { bg: theme.ink, fg: theme.surface, border: 'transparent' },
    secondary: { bg: 'transparent', fg: theme.ink, border: theme.line },
    ghost:   { bg: 'transparent', fg: theme.ink, border: 'transparent' },
    accent:  { bg: theme.accent, fg: theme.mode === 'dark' ? '#0E0B08' : '#fff', border: 'transparent' },
    danger:  { bg: 'transparent', fg: theme.danger, border: theme.line },
    chip:    { bg: theme.chip, fg: theme.ink, border: 'transparent' },
  }[kind];
  return (
    <button onClick={onClick} style={{
      height: sizes.h, padding: `0 ${sizes.px}px`, borderRadius: sizes.r,
      background: kinds.bg, color: kinds.fg, border: `1px solid ${kinds.border}`,
      fontFamily: theme.fonts.body, fontSize: sizes.fs, fontWeight: 500, letterSpacing: -0.1,
      display: 'inline-flex', alignItems: 'center', gap: sizes.gap, justifyContent: 'center',
      cursor: 'pointer', width: full ? '100%' : undefined,
      transition: 'background 120ms, color 120ms, border-color 120ms',
      ...style,
    }}>
      {leftIcon && <Icon name={leftIcon} size={sizes.fs + 3} />}
      {children}
      {rightIcon && <Icon name={rightIcon} size={sizes.fs + 3} />}
    </button>
  );
}

// ─── Chip / Tag ────────────────────────────────────────────────
function Chip({ children, active, onClick, color }) {
  const theme = window.__theme;
  return (
    <button onClick={onClick} style={{
      height: 26, padding: '0 10px', borderRadius: 999,
      background: active ? theme.ink : (color || theme.chip),
      color: active ? theme.surface : (theme.ink2),
      fontFamily: theme.fonts.body, fontSize: 12, fontWeight: 500,
      border: 'none', cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 6, letterSpacing: -0.1,
    }}>{children}</button>
  );
}

// ─── Toggle ────────────────────────────────────────────────────
function Toggle({ on, onChange }) {
  const theme = window.__theme;
  return (
    <button onClick={() => onChange && onChange(!on)} style={{
      width: 44, height: 26, padding: 2, borderRadius: 999,
      background: on ? theme.accent : (theme.mode === 'dark' ? theme.line : theme.sunken),
      border: `1px solid ${on ? theme.accent : theme.line}`,
      transition: 'background 160ms', cursor: 'pointer', display: 'flex',
    }}>
      <span style={{
        width: 20, height: 20, borderRadius: 999, background: theme.surface,
        transform: `translateX(${on ? 18 : 0}px)`, transition: 'transform 160ms',
        boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }}/>
    </button>
  );
}

// ─── Field ─────────────────────────────────────────────────────
function Field({ label, hint, error, children, mono }) {
  const theme = window.__theme;
  return (
    <Stack gap={6} style={{ width: '100%' }}>
      {label && <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>{label}</Text>}
      {children}
      {(hint || error) && <Text kind="caption" color={error ? theme.danger : theme.ink3} mono={mono}>{error || hint}</Text>}
    </Stack>
  );
}

function Input({ value, onChange, placeholder, mono, type = 'text', icon, right, autoFocus, onSubmit }) {
  const theme = window.__theme;
  const [focused, setFocused] = useState(false);
  return (
    <div style={{
      height: 44, padding: '0 12px', borderRadius: 10,
      background: theme.surface, border: `1px solid ${focused ? theme.ink2 : theme.line}`,
      display: 'flex', alignItems: 'center', gap: 8, transition: 'border-color 120ms',
    }}>
      {icon && <Icon name={icon} size={16} color={theme.ink3} />}
      <input value={value || ''} onChange={e => onChange && onChange(e.target.value)} placeholder={placeholder} type={type} autoFocus={autoFocus}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onKeyDown={e => e.key === 'Enter' && onSubmit && onSubmit()}
        style={{
          flex: 1, border: 'none', outline: 'none', background: 'transparent',
          fontFamily: mono ? theme.fonts.mono : theme.fonts.body, fontSize: 15,
          color: theme.ink, letterSpacing: -0.1,
        }} />
      {right}
    </div>
  );
}

// ─── List group / row ──────────────────────────────────────────
function ListGroup({ header, footer, children }) {
  const theme = window.__theme;
  const items = React.Children.toArray(children);
  return (
    <Stack gap={8}>
      {header && <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase', padding: '0 16px' }}>{header}</Text>}
      <div style={{
        background: theme.surface, borderRadius: 14, overflow: 'hidden',
        border: `1px solid ${theme.line}`, margin: '0 16px',
      }}>
        {items.map((c, i) => (
          <div key={i} style={{ borderBottom: i < items.length - 1 ? `1px solid ${theme.lineSoft}` : 'none' }}>{c}</div>
        ))}
      </div>
      {footer && <Text kind="caption" color={theme.ink3} style={{ padding: '0 16px' }}>{footer}</Text>}
    </Stack>
  );
}

function ListRow({ icon, iconColor, title, subtitle, detail, right, chevron, danger, onClick }) {
  const theme = window.__theme;
  const iconBg = iconColor || theme.chip;
  return (
    <div onClick={onClick} style={{
      padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
      cursor: onClick ? 'pointer' : 'default', minHeight: 56, background: 'transparent',
    }}>
      {icon && (
        <div style={{
          width: 30, height: 30, borderRadius: 8, background: iconBg,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          color: typeof iconColor === 'string' && iconColor !== theme.chip ? '#fff' : theme.ink,
        }}>
          <Icon name={icon} size={16} />
        </div>
      )}
      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
        <Text kind="bodyLg" color={danger ? theme.danger : theme.ink} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</Text>
        {subtitle && <Text kind="caption" color={theme.ink3} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{subtitle}</Text>}
      </Stack>
      {detail && <Text kind="body" color={theme.ink3}>{detail}</Text>}
      {right}
      {chevron && <Icon name="chevR" size={16} color={theme.ink3} />}
    </div>
  );
}

// ─── NavBar ────────────────────────────────────────────────────
function NavBar({ title, subtitle, leading, trailing, large, onBack }) {
  const theme = window.__theme;
  return (
    <Stack style={{
      paddingTop: 56, paddingBottom: large ? 8 : 12,
      background: theme.bg, position: 'sticky', top: 0, zIndex: 5,
    }}>
      <Row align="center" justify="space-between" style={{ padding: '0 16px', minHeight: 36 }}>
        <Row gap={4} style={{ minWidth: 0 }}>
          {onBack && (
            <button onClick={onBack} style={{ background: 'transparent', border: 'none', padding: 6, marginLeft: -6, cursor: 'pointer', color: theme.accent, display: 'flex', alignItems: 'center' }}>
              <Icon name="chevL" size={22} />
            </button>
          )}
          {leading}
        </Row>
        {!large && title && <Text kind="h3" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)' }}>{title}</Text>}
        <Row gap={4}>{trailing}</Row>
      </Row>
      {large && title && (
        <Stack gap={2} style={{ padding: '8px 16px 4px' }}>
          <Text kind="display">{title}</Text>
          {subtitle && <Text kind="body" color={theme.ink3}>{subtitle}</Text>}
        </Stack>
      )}
    </Stack>
  );
}

function NavIcon({ name, onClick, badge }) {
  const theme = window.__theme;
  return (
    <button onClick={onClick} style={{
      width: 36, height: 36, borderRadius: 10, background: 'transparent',
      border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: theme.ink, position: 'relative',
    }}>
      <Icon name={name} size={20} />
      {badge && <span style={{ position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 4, background: theme.accent, border: `2px solid ${theme.bg}` }} />}
    </button>
  );
}

// ─── Status pill (online/connecting/etc) ───────────────────────
function StatusDot({ kind = 'online' }) {
  const theme = window.__theme;
  const colors = { online: theme.positive, connecting: theme.warning, offline: theme.danger, idle: theme.ink3 };
  return <span style={{ width: 6, height: 6, borderRadius: 3, background: colors[kind], display: 'inline-block' }} />;
}

function StatusPill({ kind, label }) {
  const theme = window.__theme;
  const map = {
    online: { bg: 'transparent', fg: theme.positive, dot: 'online' },
    connecting: { bg: 'transparent', fg: theme.warning, dot: 'connecting' },
    offline: { bg: 'transparent', fg: theme.danger, dot: 'offline' },
    paused: { bg: theme.chip, fg: theme.ink2, dot: 'idle' },
  }[kind] || { bg: theme.chip, fg: theme.ink2, dot: 'idle' };
  return (
    <Row gap={6} align="center" style={{
      padding: '4px 8px', borderRadius: 999, background: map.bg,
      border: map.bg === 'transparent' ? `1px solid ${theme.line}` : 'none',
    }}>
      <StatusDot kind={map.dot} />
      <Text kind="caption" color={map.fg} style={{ fontWeight: 500 }}>{label}</Text>
    </Row>
  );
}

// ─── Section header within scroll ──────────────────────────────
function Section({ title, children, action }) {
  const theme = window.__theme;
  return (
    <Stack gap={10}>
      <Row align="center" justify="space-between" style={{ padding: '0 16px' }}>
        <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>{title}</Text>
        {action}
      </Row>
      {children}
    </Stack>
  );
}

// ─── Empty state ───────────────────────────────────────────────
function EmptyState({ icon, title, body, action }) {
  const theme = window.__theme;
  return (
    <Stack gap={12} align="center" style={{ padding: '60px 24px', alignItems: 'center', textAlign: 'center' }}>
      <div style={{ width: 56, height: 56, borderRadius: 16, background: theme.chip, display: 'flex', alignItems: 'center', justifyContent: 'center', color: theme.ink2 }}>
        <Icon name={icon || 'doc'} size={26} />
      </div>
      <Stack gap={4} style={{ alignItems: 'center' }}>
        <Text kind="h3">{title}</Text>
        {body && <Text kind="body" color={theme.ink3} style={{ textAlign: 'center', maxWidth: 280 }}>{body}</Text>}
      </Stack>
      {action}
    </Stack>
  );
}

// ─── SegControl ────────────────────────────────────────────────
function SegControl({ options, value, onChange }) {
  const theme = window.__theme;
  return (
    <Row style={{
      background: theme.sunken, borderRadius: 10, padding: 3, gap: 2,
      border: `1px solid ${theme.lineSoft}`,
    }}>
      {options.map(opt => {
        const k = typeof opt === 'string' ? opt : opt.value;
        const lbl = typeof opt === 'string' ? opt : opt.label;
        const active = value === k;
        return (
          <button key={k} onClick={() => onChange(k)} style={{
            flex: 1, height: 30, padding: '0 12px', borderRadius: 7, border: 'none',
            background: active ? theme.surface : 'transparent',
            color: active ? theme.ink : theme.ink2,
            fontFamily: theme.fonts.body, fontSize: 13, fontWeight: active ? 600 : 500,
            cursor: 'pointer', transition: 'background 120ms',
            boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
          }}>{lbl}</button>
        );
      })}
    </Row>
  );
}

// ─── ProgressBar ───────────────────────────────────────────────
function ProgressBar({ value = 0, color }) {
  const theme = window.__theme;
  return (
    <div style={{ height: 4, borderRadius: 2, background: theme.lineSoft, overflow: 'hidden' }}>
      <div style={{ width: `${value*100}%`, height: '100%', background: color || theme.accent, transition: 'width 240ms' }} />
    </div>
  );
}

// ─── MonoBlock ─────────────────────────────────────────────────
function MonoBlock({ children, color }) {
  const theme = window.__theme;
  return (
    <pre style={{
      margin: 0, padding: 12, background: theme.sunken, borderRadius: 10,
      fontFamily: theme.fonts.mono, fontSize: 12, lineHeight: '18px',
      color: color || theme.ink2, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      border: `1px solid ${theme.lineSoft}`,
    }}>{children}</pre>
  );
}

// ─── Logo wordmark ─────────────────────────────────────────────
function HermesMark({ size = 24, color }) {
  const theme = window.__theme;
  const c = color || theme.ink;
  // simple winged H glyph — original
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="11" stroke={c} strokeWidth="1.4" />
      <path d="M8 7v10M16 7v10M8 12h8" stroke={c} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M5 9l-2 1M5 12l-2 0M5 15l-2 1M19 9l2 1M19 12l2 0M19 15l2 1" stroke={c} strokeWidth="1.2" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

Object.assign(window, {
  Stack, Row, Text, Icon, Button, Chip, Toggle, Field, Input, ListGroup, ListRow,
  NavBar, NavIcon, StatusDot, StatusPill, Section, EmptyState, SegControl,
  ProgressBar, MonoBlock, HermesMark,
});
