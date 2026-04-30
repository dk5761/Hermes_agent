// Hermes screens — part 1: shell helpers, auth, sessions list, chat
// All screens are self-contained components consuming window.__theme.

const { useState: useS1, useEffect: useE1, useRef: useR1 } = React;

// ─── Phone shell ────────────────────────────────────────────────
function PhoneScreen({ children, dark, statusBar = true }) {
  const theme = window.__theme;
  return (
    <div style={{
      width: '100%', height: '100%', position: 'relative',
      background: theme.bg, color: theme.ink, overflow: 'hidden',
      fontFamily: theme.fonts.body, display: 'flex', flexDirection: 'column',
    }}>
      {statusBar && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, color: theme.ink }}>
          <IOSStatusBar dark={theme.mode === 'dark'} />
        </div>
      )}
      {children}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        height: 34, display: 'flex', justifyContent: 'center', alignItems: 'flex-end',
        paddingBottom: 8, pointerEvents: 'none', zIndex: 60,
      }}>
        <div style={{ width: 134, height: 5, borderRadius: 100,
          background: theme.mode === 'dark' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.3)' }}/>
      </div>
    </div>
  );
}

// ─── 1. LOGIN ───────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const theme = window.__theme;
  const [user, setUser] = useS1('alex');
  const [pw, setPw] = useS1('hermes-mvp-2026');
  const [err, setErr] = useS1(false);
  const [loading, setLoading] = useS1(false);
  const submit = () => {
    if (!user || !pw) { setErr(true); return; }
    setLoading(true);
    setTimeout(() => { setLoading(false); onLogin && onLogin(); }, 600);
  };
  return (
    <PhoneScreen>
      <div style={{ height: 64 }} />
      <Stack gap={32} style={{ padding: '40px 24px', flex: 1 }}>
        <Stack gap={16}>
          <HermesMark size={28} />
          <Stack gap={8}>
            <Text kind="display">Welcome back.</Text>
            <Text kind="body" color={theme.ink3}>Sign in to your Hermes gateway.</Text>
          </Stack>
        </Stack>
        <Stack gap={16}>
          <Field label="Username">
            <Input value={user} onChange={setUser} icon="user" />
          </Field>
          <Field label="Password" hint="Used to derive your local key.">
            <Input value={pw} onChange={setPw} type="password" icon="key" />
          </Field>
          {err && (
            <div style={{ padding: '10px 12px', background: theme.accentBg, borderRadius: 10, border: `1px solid ${theme.danger}33` }}>
              <Text kind="caption" color={theme.danger}>Invalid credentials. Check your gateway URL below.</Text>
            </div>
          )}
          <Button kind="accent" size="lg" full onClick={submit} rightIcon={loading ? null : 'chevR'}>
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </Stack>
      </Stack>
      <Stack gap={6} style={{ padding: '0 24px 60px' }}>
        <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Connecting to</Text>
        <Text kind="caption" mono color={theme.ink2}>https://hermes.alex.dev:8443</Text>
        <Row gap={6} align="center" style={{ marginTop: 4 }}>
          <StatusDot kind="online" />
          <Text kind="caption" color={theme.ink3}>Gateway reachable · v0.18.4</Text>
        </Row>
      </Stack>
    </PhoneScreen>
  );
}

// ─── Mock data ──────────────────────────────────────────────────
const MOCK_SESSIONS = [
  { id: 's1', title: 'Refactor cron output dispatch', preview: 'Looks like the worker drops the deliver target when…', time: '2m', unread: true, badge: 'running' },
  { id: 's2', title: 'Hermes mobile screen audit', preview: 'Here is the full inventory across auth, sessions…', time: '14m' },
  { id: 's3', title: 'PostgreSQL migration plan', preview: 'Schema diff attached. Two destructive changes need…', time: '1h', badge: 'approval' },
  { id: 's4', title: 'Sketch — onboarding video script', preview: 'Cold open on the cron list, push lands, tap → output.', time: '3h' },
  { id: 's5', title: 'Weekly digest', preview: 'You ran 142 commands across 18 sessions this week.', time: 'Mon' },
  { id: 's6', title: 'Voice memos → tasks', preview: 'Transcribed 4 memos. 2 created tickets, 2 archived.', time: 'Mon' },
  { id: 's7', title: 'iOS build cert rotation', preview: '`fastlane match nuke distribution` succeeded.', time: 'Sun' },
  { id: 's8', title: 'docs.hermes.dev redesign', preview: 'Pulled the marketing palette and the docs palette into…', time: 'Apr 24' },
];

// ─── 2. SESSION LIST ────────────────────────────────────────────
function SessionList({ onOpen, onSearch, onNew, onSettings }) {
  const theme = window.__theme;
  const [q, setQ] = useS1('');
  const [filter, setFilter] = useS1('all');
  const filtered = MOCK_SESSIONS.filter(s =>
    (filter === 'all' || (filter === 'running' && s.badge === 'running') || (filter === 'approval' && s.badge === 'approval')) &&
    (s.title.toLowerCase().includes(q.toLowerCase()) || s.preview.toLowerCase().includes(q.toLowerCase()))
  );
  return (
    <PhoneScreen>
      <NavBar
        large
        title="Chats"
        subtitle="8 sessions · 2 active"
        leading={<HermesMark size={22} />}
        trailing={<>
          <NavIcon name="search" onClick={onSearch} />
          <NavIcon name="cog" onClick={onSettings} />
        </>}
      />
      <Stack gap={12} style={{ padding: '4px 16px 8px' }}>
        <Input value={q} onChange={setQ} placeholder="Search chats" icon="search" />
        <Row gap={6} style={{ overflowX: 'auto' }}>
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All · 8</Chip>
          <Chip active={filter === 'running'} onClick={() => setFilter('running')}>● Running · 1</Chip>
          <Chip active={filter === 'approval'} onClick={() => setFilter('approval')}>Awaiting · 1</Chip>
          <Chip onClick={() => setFilter('all')}>Archived</Chip>
        </Row>
      </Stack>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 100 }}>
        {filtered.map((s, i) => (
          <div key={s.id} onClick={() => onOpen && onOpen(s)} style={{
            padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
            borderBottom: i < filtered.length - 1 ? `1px solid ${theme.lineSoft}` : 'none',
            cursor: 'pointer',
          }}>
            <div style={{
              width: 6, alignSelf: 'stretch', borderRadius: 3, marginTop: 4, marginBottom: 4,
              background: s.badge === 'running' ? theme.accent : (s.badge === 'approval' ? theme.warning : 'transparent'),
            }} />
            <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
              <Row justify="space-between" align="baseline" gap={8}>
                <Text kind="bodyLg" style={{ fontWeight: s.unread ? 600 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</Text>
                <Text kind="caption" color={theme.ink3} style={{ flexShrink: 0 }}>{s.time}</Text>
              </Row>
              <Text kind="body" color={theme.ink3} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>{s.preview}</Text>
              {s.badge && (
                <Row gap={4} style={{ marginTop: 2 }}>
                  {s.badge === 'running' && <StatusPill kind="connecting" label="running · 12s" />}
                  {s.badge === 'approval' && <StatusPill kind="connecting" label="awaiting approval" />}
                </Row>
              )}
            </Stack>
          </div>
        ))}
      </div>
      {/* FAB */}
      <button onClick={onNew} style={{
        position: 'absolute', right: 20, bottom: 56, width: 56, height: 56, borderRadius: 28,
        background: theme.ink, color: theme.surface, border: 'none', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 6px 20px rgba(0,0,0,0.25)', zIndex: 5,
      }}>
        <Icon name="plus" size={22} />
      </button>
    </PhoneScreen>
  );
}

// ─── 3. CHAT ────────────────────────────────────────────────────
const MOCK_MSGS = [
  { id: 'm1', kind: 'user', text: 'audit the missing screens in the hermes mobile app and tell me what to build next' },
  { id: 'm2', kind: 'reasoning', text: 'Reading screen-inventory.md and `app/` directory… 38 screens, 10 shipped. Cross-referencing routes against /api/config endpoints to find which settings rely on missing UI.', open: false },
  { id: 'm3', kind: 'assistant', text: 'I read the inventory. **10 shipped, 1 partial, 28 missing.** Highest-leverage gaps:\n\n1. Sessions search (`/search`)\n2. Main model picker (`/settings/model`)\n3. Provider API keys (`/settings/keys`)\n\nThe model picker depends on keys, so build keys first.' },
  { id: 'm4', kind: 'tool', tool: 'read_file', args: 'app/(app)/_layout.tsx', durationMs: 31, lines: 64, status: 'ok' },
  { id: 'm5', kind: 'tool', tool: 'grep', args: 'router.push|router.replace', durationMs: 84, status: 'ok', summary: '17 routes · 9 reachable from UI' },
  { id: 'm6', kind: 'approval', cmd: 'rm -rf app/(app)/settings/keys/.cache', reason: 'destructive · runs outside session workdir' },
  { id: 'm7', kind: 'user', text: 'approve. and start with the keys screen — give me a wireframe.' },
];

function ChatScreen({ session, onBack }) {
  const theme = window.__theme;
  const [msgs, setMsgs] = useS1(MOCK_MSGS);
  const [input, setInput] = useS1('');
  const [showApproval, setShowApproval] = useS1(true);
  const send = () => {
    if (!input.trim()) return;
    setMsgs(m => [...m, { id: 'u' + Date.now(), kind: 'user', text: input }]);
    setInput('');
  };
  return (
    <PhoneScreen>
      <NavBar
        title={session?.title || 'New chat'}
        onBack={onBack}
        trailing={<>
          <NavIcon name="more" />
        </>}
        leading={<Row gap={6} align="center" style={{ marginLeft: 4 }}>
          <StatusDot kind="online" />
          <Text kind="caption" color={theme.ink3}>online · gpt-5</Text>
        </Row>}
      />
      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column-reverse' }}>
        <Stack gap={10} style={{ padding: '12px 12px 12px' }}>
          {msgs.map(m => <Message key={m.id} m={m} />)}
        </Stack>
      </div>
      {/* Composer */}
      <div style={{
        padding: '8px 10px 10px',
        background: theme.bg,
        borderTop: `1px solid ${theme.lineSoft}`,
      }}>
        <Row gap={8} align="flex-end" style={{
          padding: '6px 6px 6px 12px',
          background: theme.surface, borderRadius: 22, border: `1px solid ${theme.line}`,
        }}>
          <button style={{ width: 32, height: 32, borderRadius: 16, border: 'none', background: 'transparent', color: theme.ink2, cursor: 'pointer', flexShrink: 0 }}>
            <Icon name="plus" size={18} />
          </button>
          <textarea value={input} onChange={e => setInput(e.target.value)} placeholder="Message Hermes…" rows={1} style={{
            flex: 1, border: 'none', outline: 'none', background: 'transparent',
            fontFamily: theme.fonts.body, fontSize: 15, color: theme.ink, resize: 'none',
            padding: '8px 0', lineHeight: '20px', minHeight: 20, maxHeight: 100,
          }} />
          <button onClick={send} style={{
            width: 32, height: 32, borderRadius: 16, border: 'none', cursor: 'pointer',
            background: input.trim() ? theme.ink : theme.chip,
            color: input.trim() ? theme.surface : theme.ink3,
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <Icon name="send" size={16} />
          </button>
        </Row>
      </div>
      <div style={{ height: 24 }} />
    </PhoneScreen>
  );
}

function Message({ m }) {
  const theme = window.__theme;
  if (m.kind === 'user') {
    return (
      <Row justify="flex-end">
        <div style={{
          maxWidth: '78%', padding: '10px 14px', borderRadius: 18,
          background: theme.ink, color: theme.surface,
          fontSize: 15, lineHeight: '20px',
        }}>{m.text}</div>
      </Row>
    );
  }
  if (m.kind === 'assistant') {
    return (
      <div style={{ padding: '4px 8px', maxWidth: '92%' }}>
        <Text kind="body" style={{ whiteSpace: 'pre-wrap', display: 'block' }}>{m.text.split('**').map((t, i) => i % 2 ? <strong key={i}>{t}</strong> : t)}</Text>
      </div>
    );
  }
  if (m.kind === 'reasoning') {
    return (
      <div style={{
        padding: '8px 12px', borderRadius: 12,
        background: theme.sunken, border: `1px solid ${theme.lineSoft}`,
        margin: '0 6px',
      }}>
        <Row gap={6} align="center">
          <Icon name="spark" size={12} color={theme.ink3} />
          <Text kind="caption" color={theme.ink3} style={{ fontWeight: 500 }}>Thinking · 4.2s</Text>
        </Row>
        <Text kind="caption" color={theme.ink2} mono style={{ display: 'block', marginTop: 4, lineHeight: '17px' }}>{m.text}</Text>
      </div>
    );
  }
  if (m.kind === 'tool') {
    return (
      <div style={{
        margin: '0 6px', padding: '10px 12px',
        background: theme.surface, borderRadius: 12, border: `1px solid ${theme.line}`,
      }}>
        <Row gap={8} align="center" justify="space-between">
          <Row gap={8} align="center" style={{ minWidth: 0 }}>
            <div style={{ width: 22, height: 22, borderRadius: 6, background: theme.chip, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={m.tool === 'grep' ? 'search' : (m.tool === 'read_file' ? 'doc' : 'terminal')} size={12} />
            </div>
            <Text kind="label" mono>{m.tool}</Text>
            <Text kind="caption" color={theme.ink3} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.args}</Text>
          </Row>
          <Text kind="caption" color={theme.ink3} mono>{m.durationMs}ms</Text>
        </Row>
        {m.summary && <Text kind="caption" color={theme.ink2} style={{ display: 'block', marginTop: 6 }}>{m.summary}</Text>}
        {m.lines && <Text kind="caption" color={theme.ink3} mono style={{ display: 'block', marginTop: 4 }}>{m.lines} lines · ok</Text>}
      </div>
    );
  }
  if (m.kind === 'approval') {
    return (
      <div style={{
        margin: '0 6px', padding: 12, borderRadius: 12,
        background: theme.surface, border: `1px solid ${theme.warning}66`,
      }}>
        <Row gap={6} align="center">
          <Icon name="shield" size={14} color={theme.warning} />
          <Text kind="label" color={theme.warning}>Approval requested</Text>
        </Row>
        <div style={{ marginTop: 8, padding: 10, background: theme.sunken, borderRadius: 8 }}>
          <Text kind="caption" mono>$ {m.cmd}</Text>
        </div>
        <Text kind="caption" color={theme.ink3} style={{ display: 'block', marginTop: 6 }}>{m.reason}</Text>
        <Row gap={8} style={{ marginTop: 10 }}>
          <Button kind="secondary" size="sm">Deny</Button>
          <Button kind="secondary" size="sm">Once</Button>
          <Button kind="primary" size="sm" style={{ flex: 1 }}>Approve</Button>
        </Row>
      </div>
    );
  }
  return null;
}

window.HSCREENS_1 = { LoginScreen, SessionList, ChatScreen, PhoneScreen };
Object.assign(window, { LoginScreen, SessionList, ChatScreen, PhoneScreen });
