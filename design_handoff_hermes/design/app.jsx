// Hermes prototype host — wires all screens, manages navigation,
// theme variants, density, font pairings, tweaks panel.
// Renders both the Design Canvas (overview) and a Hero Device (focused).

const { useState: useSh, useMemo: useM, useEffect: useEh } = React;

// ─── Theme provider ─────────────────────────────────────────────
function applyTheme(theme) {
  window.__theme = theme;
  // also push CSS vars on root for any non-React consumers
  const r = document.documentElement.style;
  Object.entries(theme).forEach(([k, v]) => {
    if (typeof v === 'string') r.setProperty('--' + k, v);
  });
  if (theme.fonts) {
    r.setProperty('--font-display', theme.fonts.display);
    r.setProperty('--font-body', theme.fonts.body);
    r.setProperty('--font-mono', theme.fonts.mono);
  }
}

// ─── Themed wrapper that can render any screen ──────────────────
function Themed({ variant, mode, fontKey, density, children }) {
  const theme = useM(() => window.resolveTheme(variant, mode, fontKey), [variant, mode, fontKey]);
  // re-apply on each render — cheap, ensures the global is current
  applyTheme(theme);
  window.__density = window.HERMES.density[density] || window.HERMES.density.comfortable;
  return <div style={{ width: '100%', height: '100%', background: theme.bg, color: theme.ink, fontFamily: theme.fonts.body }}>{children}</div>;
}

// ─── Prototype navigator ────────────────────────────────────────
function Prototype({ variant, mode, fontKey, density, initialRoute = 'sessions' }) {
  const [stack, setStack] = useSh([initialRoute]);
  const [params, setParams] = useSh({});
  const route = stack[stack.length - 1];

  const push = (r, p = {}) => { setStack(s => [...s, r]); setParams(p); };
  const pop = () => setStack(s => s.length > 1 ? s.slice(0, -1) : s);
  const replace = (r) => setStack([r]);

  const screen = (() => {
    switch (route) {
      case 'login': return <LoginScreen onLogin={() => replace('sessions')} />;
      case 'sessions': return <SessionList onOpen={s => push('chat', { session: s })} onSearch={() => push('search')} onNew={() => push('chat', { session: null })} onSettings={() => push('settings')} />;
      case 'chat': return <ChatScreen session={params.session} onBack={pop} />;
      case 'search': return <SearchScreen onBack={pop} onOpen={s => push('chat', { session: { title: s.session } })} />;
      case 'cron': return <CronList onOpen={j => push('cronJob', { job: j })} onNew={() => push('cronEdit', {})} onBack={pop} />;
      case 'cronJob': return <CronDetail job={params.job} onBack={pop} onOutput={o => push('cronOut', { output: o, job: params.job })} />;
      case 'cronOut': return <CronOutput output={params.output} job={params.job} onBack={pop} />;
      case 'cronEdit': return <CronEditor onBack={pop} jobId={params.jobId} />;
      case 'settings': return <SettingsIndex onBack={pop} onPick={k => push(k)} />;
      case 'model': return <ModelPicker onBack={pop} />;
      case 'vision': return <VisionScreen onBack={pop} kind="vision" />;
      case 'aux': return <AuxScreen onBack={pop} onPick={k => push('vision' /* reuse */, { kind: k })} />;
      case 'keys': return <KeysScreen onBack={pop} onTap={p => push('keyEdit', { provider: p })} />;
      case 'keyEdit': return <KeyEditor provider={params.provider} onBack={pop} />;
      case 'notifications': return <NotificationsScreen onBack={pop} />;
      case 'storage': return <StorageScreen onBack={pop} />;
      case 'diag': return <LogsScreen onBack={pop} />;
      case 'account': return <AccountScreen onBack={pop} />;
      case 'about': return <AboutScreen onBack={pop} />;
      case 'usage': return <UsageScreen onBack={pop} />;
      case 'tools': return <ToolsScreen onBack={pop} />;
      case 'skills': return <SkillsScreen onBack={pop} />;
      case 'onboarding': return <OnboardingFlow onBack={() => replace('sessions')} />;
      case 'lightbox': return <ImageLightbox onClose={pop} />;
      case 'tool': return <ToolDetailScreen onBack={pop} />;
      case 'approval': return <ApprovalModal onBack={pop} />;
      default: return <SessionList onOpen={s => push('chat', { session: s })} onSearch={() => push('search')} onNew={() => push('chat')} onSettings={() => push('settings')} />;
    }
  })();

  return <Themed variant={variant} mode={mode} fontKey={fontKey} density={density}>{screen}</Themed>;
}

// ─── Tabbed bottom nav (overlay on the hero device) ─────────────
function HeroTabBar({ tab, setTab }) {
  const theme = window.__theme;
  const tabs = [
    { id: 'sessions', icon: 'terminal', label: 'Chats' },
    { id: 'cron', icon: 'clock', label: 'Cron' },
    { id: 'settings', icon: 'cog', label: 'Settings' },
  ];
  return (
    <div style={{
      position: 'absolute', bottom: 16, left: 12, right: 12, zIndex: 70,
      padding: 4, borderRadius: 28,
      background: theme.mode === 'dark' ? 'rgba(28,28,30,0.85)' : 'rgba(255,255,255,0.85)',
      backdropFilter: 'blur(20px) saturate(180%)',
      border: `1px solid ${theme.line}`, boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
      display: 'flex', gap: 4,
    }}>
      {tabs.map(t => {
        const active = tab === t.id;
        return (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: '8px 0', border: 'none', cursor: 'pointer',
            background: active ? theme.ink : 'transparent', borderRadius: 22,
            color: active ? theme.surface : theme.ink2,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            fontFamily: theme.fonts.body,
          }}>
            <Icon name={t.icon} size={16} />
            <span style={{ fontSize: 10, fontWeight: 500, letterSpacing: 0.2 }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Hero device (focusable single phone, navigable) ────────────
function HeroDevice({ variant, mode, fontKey, density }) {
  const [tab, setTab] = useSh('sessions');
  const theme = useM(() => window.resolveTheme(variant, mode, fontKey), [variant, mode, fontKey]);
  return (
    <div style={{ position: 'relative', width: 402, height: 874 }}>
      <div style={{
        width: 402, height: 874, borderRadius: 48, overflow: 'hidden',
        position: 'relative', background: theme.bg,
        boxShadow: '0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)',
      }}>
        <div style={{
          position: 'absolute', top: 11, left: '50%', transform: 'translateX(-50%)',
          width: 126, height: 37, borderRadius: 24, background: '#000', zIndex: 80,
        }} />
        <Prototype variant={variant} mode={mode} fontKey={fontKey} density={density} initialRoute={tab} key={tab + variant + mode + fontKey} />
      </div>
    </div>
  );
}

// ─── Wrap a screen in a phone bezel for the canvas ──────────────
function Bezel({ children, dark }) {
  return (
    <div style={{
      width: 402, height: 874, borderRadius: 48, overflow: 'hidden',
      position: 'relative', background: dark ? '#000' : '#F2F2F7',
      boxShadow: '0 0 0 1px rgba(0,0,0,0.10)',
    }}>
      <div style={{
        position: 'absolute', top: 11, left: '50%', transform: 'translateX(-50%)',
        width: 126, height: 37, borderRadius: 24, background: '#000', zIndex: 80,
      }} />
      {children}
    </div>
  );
}

// Canvas card: a single screen route, themed
function Card({ variant, mode, fontKey, density, route, params }) {
  const theme = useM(() => window.resolveTheme(variant, mode, fontKey), [variant, mode, fontKey]);
  return (
    <Bezel dark={theme.mode === 'dark'}>
      <Prototype variant={variant} mode={mode} fontKey={fontKey} density={density} initialRoute={route} />
    </Bezel>
  );
}

Object.assign(window, { Themed, Prototype, HeroDevice, Card, HeroTabBar, applyTheme });
