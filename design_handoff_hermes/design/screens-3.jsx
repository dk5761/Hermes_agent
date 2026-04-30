// Hermes screens — part 3: settings hub, model picker, keys, vision, aux,
// notifications, storage, logs, account, about, analytics, tools, skills

const { useState: useS3 } = React;

// ─── Settings index ─────────────────────────────────────────────
function SettingsIndex({ onBack, onPick }) {
  const theme = window.__theme;
  return (
    <PhoneScreen>
      <NavBar large title="Settings" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={20}>
          {/* Identity */}
          <div style={{ margin: '0 16px', padding: 14, background: theme.surface, borderRadius: 14, border: `1px solid ${theme.line}` }}>
            <Row gap={12} align="center">
              <div style={{ width: 44, height: 44, borderRadius: 22, background: theme.accentBg, color: theme.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontFamily: theme.fonts.display }}>AC</div>
              <Stack gap={2}>
                <Text kind="bodyLg" style={{ fontWeight: 600 }}>alex@hermes</Text>
                <Text kind="caption" mono color={theme.ink3}>hermes.alex.dev:8443 · v0.18.5</Text>
              </Stack>
            </Row>
          </div>

          <ListGroup header="Models">
            <ListRow icon="spark" iconColor={theme.accentBg} title="Main model" detail="gpt-5" chevron onClick={() => onPick('model')} />
            <ListRow icon="image" title="Vision" detail="auto" chevron onClick={() => onPick('vision')} />
            <ListRow icon="flow" title="Other auxiliary models" detail="5 of 5 auto" chevron onClick={() => onPick('aux')} />
            <ListRow icon="key" title="Provider API keys" detail="4 set · 18 unset" chevron onClick={() => onPick('keys')} />
          </ListGroup>

          <ListGroup header="Workspace">
            <ListRow icon="bolt" title="Tools & toolsets" detail="3 enabled" chevron onClick={() => onPick('tools')} />
            <ListRow icon="hash" title="Skills" detail="12" chevron onClick={() => onPick('skills')} />
            <ListRow icon="bell" title="Notifications" detail="On" chevron onClick={() => onPick('notifications')} />
            <ListRow icon="database" title="Storage" detail="2.4 GB" chevron onClick={() => onPick('storage')} />
          </ListGroup>

          <ListGroup header="Account">
            <ListRow icon="shieldCheck" title="Account & security" chevron onClick={() => onPick('account')} />
            <ListRow icon="terminal" title="Logs & diagnostics" chevron onClick={() => onPick('diag')} />
            <ListRow icon="bolt" title="Usage & costs" detail="$24.18 · 30d" chevron onClick={() => onPick('usage')} />
            <ListRow icon="doc" title="About" chevron onClick={() => onPick('about')} />
          </ListGroup>

          <ListGroup>
            <ListRow icon="chevR" iconColor={theme.danger + '22'} title="Sign out" danger />
          </ListGroup>

          <Text kind="caption" color={theme.ink3} style={{ textAlign: 'center', padding: '8px 16px' }}>Hermes Mobile · build 1842</Text>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

// ─── Main model picker ──────────────────────────────────────────
const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', models: [
    { id: 'gpt-5', label: 'gpt-5', ctx: '400k', flags: ['vision', 'tools', 'reasoning'] },
    { id: 'gpt-5-mini', label: 'gpt-5 mini', ctx: '256k', flags: ['vision', 'tools'] },
    { id: 'gpt-4o', label: 'gpt-4o', ctx: '128k', flags: ['vision', 'tools'] },
  ]},
  { id: 'anthropic', name: 'Anthropic', models: [
    { id: 'claude-opus-4.5', label: 'claude opus 4.5', ctx: '200k', flags: ['vision', 'tools', 'reasoning'] },
    { id: 'claude-sonnet-4.5', label: 'claude sonnet 4.5', ctx: '200k', flags: ['vision', 'tools'] },
    { id: 'claude-haiku-4.5', label: 'claude haiku 4.5', ctx: '200k', flags: ['vision', 'tools'] },
  ]},
  { id: 'google', name: 'Google', models: [
    { id: 'gemini-2.5-pro', label: 'gemini 2.5 pro', ctx: '1M', flags: ['vision', 'tools', 'reasoning'] },
    { id: 'gemini-2.5-flash', label: 'gemini 2.5 flash', ctx: '1M', flags: ['vision', 'tools'] },
  ]},
  { id: 'xai', name: 'xAI', models: [
    { id: 'grok-4', label: 'grok 4', ctx: '256k', flags: ['vision', 'tools'] },
  ]},
];

function ModelPicker({ onBack }) {
  const theme = window.__theme;
  const [q, setQ] = useS3('');
  const [filter, setFilter] = useS3({ vision: false, tools: false, reasoning: false });
  const [picked, setPicked] = useS3('gpt-5');

  return (
    <PhoneScreen>
      <NavBar title="Main model" onBack={onBack} />
      <Stack gap={12} style={{ padding: '8px 16px 12px' }}>
        {/* Current */}
        <div style={{ padding: 14, background: theme.surface, borderRadius: 12, border: `1px solid ${theme.line}` }}>
          <Row justify="space-between" align="flex-start">
            <Stack gap={4}>
              <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Currently using</Text>
              <Text kind="h2">gpt-5</Text>
              <Text kind="caption" mono color={theme.ink3}>openai · 400k ctx</Text>
            </Stack>
            <Row gap={4} style={{ flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 140 }}>
              <CapBadge>vision</CapBadge>
              <CapBadge>tools</CapBadge>
              <CapBadge>reasoning</CapBadge>
            </Row>
          </Row>
        </div>
        <Input value={q} onChange={setQ} icon="search" placeholder="Search models or providers" />
        <Row gap={6}>
          <Chip active={filter.vision} onClick={() => setFilter(f => ({ ...f, vision: !f.vision }))}>Vision</Chip>
          <Chip active={filter.tools} onClick={() => setFilter(f => ({ ...f, tools: !f.tools }))}>Tool-calling</Chip>
          <Chip active={filter.reasoning} onClick={() => setFilter(f => ({ ...f, reasoning: !f.reasoning }))}>Reasoning</Chip>
        </Row>
      </Stack>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={18}>
          {PROVIDERS.map(p => {
            const ms = p.models.filter(m =>
              (m.label.includes(q.toLowerCase()) || p.name.toLowerCase().includes(q.toLowerCase())) &&
              (!filter.vision || m.flags.includes('vision')) &&
              (!filter.tools || m.flags.includes('tools')) &&
              (!filter.reasoning || m.flags.includes('reasoning'))
            );
            if (!ms.length) return null;
            return (
              <Stack key={p.id} gap={8}>
                <Row justify="space-between" align="center" style={{ padding: '0 16px' }}>
                  <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>{p.name}</Text>
                  <Text kind="caption" color={theme.positive}>● key set</Text>
                </Row>
                <Stack gap={1} style={{ margin: '0 16px', borderRadius: 12, background: theme.surface, border: `1px solid ${theme.line}`, overflow: 'hidden' }}>
                  {ms.map((m, i) => (
                    <div key={m.id} onClick={() => setPicked(m.id)} style={{
                      padding: '12px 14px', cursor: 'pointer',
                      borderBottom: i < ms.length - 1 ? `1px solid ${theme.lineSoft}` : 'none',
                      background: picked === m.id ? theme.accentBg : 'transparent',
                    }}>
                      <Row gap={10} align="center">
                        <div style={{ width: 18, height: 18, borderRadius: 9, border: `1.5px solid ${picked === m.id ? theme.accent : theme.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {picked === m.id && <div style={{ width: 8, height: 8, borderRadius: 4, background: theme.accent }} />}
                        </div>
                        <Stack gap={2} style={{ flex: 1 }}>
                          <Text kind="bodyLg" mono>{m.label}</Text>
                          <Row gap={6} align="center">
                            <Text kind="caption" color={theme.ink3}>{m.ctx} ctx</Text>
                            {m.flags.map(f => (
                              <span key={f} style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: theme.chip, color: theme.ink2, fontWeight: 500 }}>{f}</span>
                            ))}
                          </Row>
                        </Stack>
                      </Row>
                    </div>
                  ))}
                </Stack>
              </Stack>
            );
          })}
        </Stack>
      </div>
    </PhoneScreen>
  );
}

function CapBadge({ children }) {
  const theme = window.__theme;
  return <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: theme.chip, color: theme.ink2, fontWeight: 500, fontFamily: theme.fonts.mono }}>{children}</span>;
}

// ─── Provider keys ──────────────────────────────────────────────
const KEY_PROVIDERS = [
  { id: 'openai', name: 'OpenAI', envKey: 'OPENAI_API_KEY', set: true, masked: 'sk-•••••4f2a' },
  { id: 'anthropic', name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', set: true, masked: 'sk-ant-•••••7c9' },
  { id: 'google', name: 'Google AI Studio', envKey: 'GOOGLE_GENERATIVE_AI_API_KEY', set: true, masked: 'AI•••••bf3' },
  { id: 'xai', name: 'xAI', envKey: 'XAI_API_KEY', set: true, masked: 'xai-•••••92e' },
  { id: 'mistral', name: 'Mistral', envKey: 'MISTRAL_API_KEY', set: false },
  { id: 'cohere', name: 'Cohere', envKey: 'COHERE_API_KEY', set: false },
  { id: 'groq', name: 'Groq', envKey: 'GROQ_API_KEY', set: false },
  { id: 'together', name: 'Together', envKey: 'TOGETHER_API_KEY', set: false },
  { id: 'fireworks', name: 'Fireworks', envKey: 'FIREWORKS_API_KEY', set: false },
];

function KeysScreen({ onBack, onTap }) {
  const theme = window.__theme;
  const [q, setQ] = useS3('');
  const visible = KEY_PROVIDERS.filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
  const setCount = KEY_PROVIDERS.filter(p => p.set).length;
  return (
    <PhoneScreen>
      <NavBar title="API keys" onBack={onBack} />
      <Stack gap={10} style={{ padding: '8px 16px 12px' }}>
        <Row gap={8} align="center" style={{ padding: '10px 12px', background: theme.surface, borderRadius: 10, border: `1px solid ${theme.line}` }}>
          <Icon name="shieldCheck" size={16} color={theme.positive} />
          <Stack gap={2} style={{ flex: 1 }}>
            <Text kind="label">{setCount} keys set</Text>
            <Text kind="caption" color={theme.ink3}>Stored in <span style={{ fontFamily: theme.fonts.mono }}>~/.hermes/.env</span> on the gateway.</Text>
          </Stack>
        </Row>
        <Input value={q} onChange={setQ} icon="search" placeholder="Search providers" />
      </Stack>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={16}>
          <ListGroup header="Configured">
            {visible.filter(p => p.set).map(p => (
              <ListRow key={p.id} icon="key" iconColor={theme.accentBg} title={p.name} subtitle={p.envKey} detail={p.masked}
                right={<Text kind="caption" color={theme.positive} style={{ marginRight: 6, fontFamily: theme.fonts.mono }}>set</Text>}
                chevron onClick={() => onTap && onTap(p)} />
            ))}
          </ListGroup>
          <ListGroup header="Available providers">
            {visible.filter(p => !p.set).map(p => (
              <ListRow key={p.id} icon="key" title={p.name} subtitle={p.envKey} chevron onClick={() => onTap && onTap(p)} />
            ))}
          </ListGroup>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

function KeyEditor({ provider, onBack }) {
  const theme = window.__theme;
  const p = provider || KEY_PROVIDERS[4];
  const [val, setVal] = useS3(p.set ? '••••••••••••••••••••••••' : '');
  const [reveal, setReveal] = useS3(false);
  return (
    <PhoneScreen>
      <NavBar title={p.name} onBack={onBack}
        trailing={<button style={{ background: 'transparent', border: 'none', color: theme.accent, fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: 6 }}>Save</button>} />
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={20} style={{ padding: '12px 0' }}>
          <Stack gap={12} style={{ padding: '0 16px' }}>
            <Field label="Environment variable">
              <Input value={p.envKey} mono onChange={() => {}} right={
                <button style={{ background: 'transparent', border: 'none', color: theme.ink3, cursor: 'pointer' }}>
                  <Icon name="copy" size={16} />
                </button>
              } />
            </Field>
            <Field label="API key" hint="Falls back to the env var on the host if unset.">
              <Input value={val} onChange={setVal} mono type={reveal ? 'text' : 'password'} icon="key"
                right={
                  <button onClick={() => setReveal(r => !r)} style={{ background: 'transparent', border: 'none', color: theme.ink3, cursor: 'pointer' }}>
                    <Icon name={reveal ? 'eyeOff' : 'eye'} size={16} />
                  </button>
                } />
            </Field>
            <Row gap={8}>
              <Button kind="secondary" full leftIcon="bolt">Test</Button>
              <Button kind="danger" full leftIcon="trash">Remove</Button>
            </Row>
          </Stack>
          <Section title="Models that use this">
            <ListGroup>
              <ListRow icon="spark" title="Main model" detail="gpt-5" />
              <ListRow icon="image" title="Vision" detail="auto" />
              <ListRow icon="flow" title="Approval" detail="auto" />
            </ListGroup>
          </Section>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

// ─── Vision / aux model picker (single screen, reusable) ────────
function VisionScreen({ onBack, kind = 'vision' }) {
  const theme = window.__theme;
  const titles = {
    vision: 'Vision', extract: 'Web extract', compress: 'Compression',
    search: 'Session search', skills: 'Skills hub', approval: 'Approval',
  };
  const [provider, setProvider] = useS3('auto');
  const [model, setModel] = useS3('gpt-4o-mini');
  const providers = ['auto', 'custom', 'openai', 'anthropic', 'google', 'xai', 'mistral'];
  return (
    <PhoneScreen>
      <NavBar title={titles[kind]} onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={18} style={{ padding: '12px 0' }}>
          <div style={{ margin: '0 16px', padding: 14, background: theme.accentBg, borderRadius: 12, border: `1px solid ${theme.accent}33` }}>
            <Row gap={10} align="flex-start">
              <Icon name="spark" size={16} color={theme.accent} />
              <Stack gap={3} style={{ flex: 1 }}>
                <Text kind="label" color={theme.accent}>Currently using auto</Text>
                <Text kind="caption" color={theme.ink2}>Hermes picks the cheapest vision-capable model with a configured key. Override here.</Text>
              </Stack>
            </Row>
          </div>

          <Section title="Provider">
            <ListGroup>
              {providers.map(p => (
                <ListRow key={p} title={p} chevron={false}
                  onClick={() => setProvider(p)}
                  right={
                    <div style={{ width: 18, height: 18, borderRadius: 9, border: `1.5px solid ${provider === p ? theme.accent : theme.line}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 4 }}>
                      {provider === p && <div style={{ width: 8, height: 8, borderRadius: 4, background: theme.accent }} />}
                    </div>
                  } />
              ))}
            </ListGroup>
          </Section>

          <Section title="Model">
            <Stack gap={10} style={{ padding: '0 16px' }}>
              <Field label="Model name"><Input value={model} onChange={setModel} mono /></Field>
              <Row gap={6} style={{ flexWrap: 'wrap' }}>
                <Chip onClick={() => setModel('gpt-4o-mini')}>gpt-4o-mini</Chip>
                <Chip onClick={() => setModel('gpt-5-mini')}>gpt-5-mini</Chip>
                <Chip onClick={() => setModel('claude-haiku-4.5')}>claude-haiku-4.5</Chip>
                <Chip onClick={() => setModel('gemini-2.5-flash')}>gemini-2.5-flash</Chip>
              </Row>
            </Stack>
          </Section>

          {provider === 'custom' && (
            <Section title="Custom endpoint">
              <Stack gap={10} style={{ padding: '0 16px' }}>
                <Field label="Base URL"><Input value="https://api.example.com/v1" mono onChange={() => {}} /></Field>
                <Field label="API key"><Input value="" placeholder="sk-…" type="password" mono icon="key" onChange={() => {}} /></Field>
              </Stack>
            </Section>
          )}

          <Stack gap={8} style={{ padding: '0 16px' }}>
            <Button kind="secondary" full leftIcon="image">Test with sample image</Button>
          </Stack>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

// ─── Other aux models hub ───────────────────────────────────────
function AuxScreen({ onBack, onPick }) {
  const theme = window.__theme;
  const items = [
    { kind: 'extract', icon: 'globe', title: 'Web extract', subtitle: 'Used by browser & scraping tools' },
    { kind: 'compress', icon: 'archive', title: 'Compression', subtitle: 'Compacts long contexts' },
    { kind: 'search', icon: 'search', title: 'Session search', subtitle: 'Summarizes FTS5 hits across chats' },
    { kind: 'skills', icon: 'hash', title: 'Skills hub', subtitle: 'Classifies which skill to load' },
    { kind: 'approval', icon: 'shield', title: 'Approval', subtitle: 'Pre-judges destructive commands' },
  ];
  return (
    <PhoneScreen>
      <NavBar title="Auxiliary models" onBack={onBack} />
      <Text kind="caption" color={theme.ink3} style={{ padding: '0 16px 12px', display: 'block' }}>
        Override individual subsystems. Defaults to <span style={{ fontFamily: theme.fonts.mono }}>auto</span> — leave alone unless you need control.
      </Text>
      <ListGroup>
        {items.map(it => (
          <ListRow key={it.kind} icon={it.icon} iconColor={theme.chip} title={it.title} subtitle={it.subtitle} detail="auto" chevron
            onClick={() => onPick && onPick(it.kind)} />
        ))}
      </ListGroup>
    </PhoneScreen>
  );
}

// ─── Notifications ──────────────────────────────────────────────
function NotificationsScreen({ onBack }) {
  const theme = window.__theme;
  const [cron, setCron] = useS3(true);
  const [approval, setApproval] = useS3(true);
  const [tool, setTool] = useS3(false);
  const [quiet, setQuiet] = useS3(true);
  return (
    <PhoneScreen>
      <NavBar title="Notifications" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={18}>
          <div style={{ margin: '0 16px', padding: 14, background: theme.surface, borderRadius: 12, border: `1px solid ${theme.line}` }}>
            <Row gap={10} align="center">
              <div style={{ width: 36, height: 36, borderRadius: 18, background: theme.positive + '22', color: theme.positive, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="bell" size={18} />
              </div>
              <Stack gap={2} style={{ flex: 1 }}>
                <Text kind="label">Allowed</Text>
                <Text kind="caption" color={theme.ink3}>Push, sound, badges</Text>
              </Stack>
              <Button kind="secondary" size="sm">System</Button>
            </Row>
          </div>

          <ListGroup header="Categories">
            <ListRow icon="clock" title="Cron completions" subtitle="Per-job toggles below" right={<Toggle on={cron} onChange={setCron} />} />
            <ListRow icon="shield" iconColor={theme.warning + '22'} title="Approval requests" subtitle="When Hermes is blocked on you" right={<Toggle on={approval} onChange={setApproval} />} />
            <ListRow icon="bolt" title="Long tool completions" subtitle="Tools that ran > 60s" right={<Toggle on={tool} onChange={setTool} />} />
          </ListGroup>

          <ListGroup header="Quiet hours" footer="Notifications are silenced during these hours; badges still update.">
            <ListRow title="Enabled" right={<Toggle on={quiet} onChange={setQuiet} />} chevron={false} />
            <ListRow title="From" detail="22:00" chevron />
            <ListRow title="To" detail="07:00" chevron />
          </ListGroup>

          <ListGroup header="Per-job">
            {MOCK_JOBS.slice(0, 4).map(j => <ListRow key={j.id} icon="clock" title={j.name} right={<Toggle on={j.notify} onChange={() => {}} />} chevron={false} />)}
          </ListGroup>

          <ListGroup header="Device">
            <ListRow icon="key" title="Push token" detail="…f2a3b" chevron />
            <ListRow icon="bolt" title="Send test push" chevron={false} right={<Text kind="caption" color={theme.accent} style={{ marginRight: 4 }}>Send</Text>} />
          </ListGroup>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

// ─── Storage ────────────────────────────────────────────────────
function StorageScreen({ onBack }) {
  const theme = window.__theme;
  const [tab, setTab] = useS3('app');
  return (
    <PhoneScreen>
      <NavBar title="Storage" onBack={onBack} />
      <div style={{ padding: '0 16px 12px' }}>
        <SegControl options={[{ value: 'app', label: 'App cache' }, { value: 'srv', label: 'Server' }]} value={tab} onChange={setTab} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        {tab === 'app' ? (
          <Stack gap={16}>
            <div style={{ margin: '0 16px', padding: 16, background: theme.surface, borderRadius: 14, border: `1px solid ${theme.line}` }}>
              <Stack gap={10}>
                <Row justify="space-between" align="baseline">
                  <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>App cache</Text>
                  <Text kind="h2" mono>342 MB</Text>
                </Row>
                <ProgressBar value={0.34} />
                <Row gap={4} style={{ flexWrap: 'wrap' }}>
                  <UsageRow label="Thumbnails" value="124 MB" w={0.36} />
                  <UsageRow label="Attachments" value="186 MB" w={0.54} />
                  <UsageRow label="Tokens" value="32 MB" w={0.10} />
                </Row>
              </Stack>
            </div>
            <ListGroup>
              <ListRow icon="image" title="Clear thumbnail cache" detail="124 MB" chevron />
              <ListRow icon="doc" title="Clear attachment cache" detail="186 MB" chevron />
              <ListRow icon="trash" iconColor={theme.danger + '22'} title="Clear all" danger />
            </ListGroup>
          </Stack>
        ) : (
          <Stack gap={16}>
            <div style={{ margin: '0 16px', padding: 16, background: theme.surface, borderRadius: 14, border: `1px solid ${theme.line}` }}>
              <Stack gap={10}>
                <Row justify="space-between" align="baseline">
                  <Stack gap={2}>
                    <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Gateway storage</Text>
                    <Text kind="caption" mono color={theme.ink3}>local · /var/hermes/blobs</Text>
                  </Stack>
                  <Text kind="h2" mono>2.4 GB</Text>
                </Row>
                <ProgressBar value={0.62} />
                <Stack gap={4}>
                  <UsageRow label="Images" value="1.2 GB" w={0.50} />
                  <UsageRow label="PDFs" value="780 MB" w={0.32} />
                  <UsageRow label="Derived" value="412 MB" w={0.18} />
                </Stack>
              </Stack>
            </div>
            <ListGroup header="Last cleanup">
              <ListRow icon="refresh" title="Apr 28 · 02:14 UTC" subtitle="Removed 1,243 orphan blobs · 412 MB freed" />
              <ListRow icon="bolt" title="Run cleanup now" chevron={false} right={<Text kind="caption" color={theme.accent} style={{ marginRight: 4 }}>Run</Text>} />
            </ListGroup>
          </Stack>
        )}
      </div>
    </PhoneScreen>
  );
}

function UsageRow({ label, value, w }) {
  const theme = window.__theme;
  return (
    <Stack gap={4} style={{ width: '100%' }}>
      <Row justify="space-between"><Text kind="caption" color={theme.ink2}>{label}</Text><Text kind="caption" mono color={theme.ink3}>{value}</Text></Row>
      <div style={{ height: 3, borderRadius: 2, background: theme.lineSoft, overflow: 'hidden' }}>
        <div style={{ width: `${w*100}%`, height: '100%', background: theme.ink2 }} />
      </div>
    </Stack>
  );
}

// ─── Logs / diagnostics ─────────────────────────────────────────
function LogsScreen({ onBack }) {
  const theme = window.__theme;
  const [tab, setTab] = useS3('hermes');
  const [file, setFile] = useS3('agent');
  const lines = `[2026-05-01T08:14:32.118Z] [agent] session sess_4e2a started · model=gpt-5
[2026-05-01T08:14:32.224Z] [agent] tools loaded: read_file, grep, write_file (+24)
[2026-05-01T08:14:33.001Z] [agent] tool=read_file path=app/_layout.tsx ok 31ms
[2026-05-01T08:14:33.404Z] [agent] tool=grep pattern="router.push" matches=17 ok 84ms
[2026-05-01T08:14:35.812Z] [agent] llm req=1 tokens.in=4218 cache=hit
[2026-05-01T08:14:38.220Z] [agent] llm req=1 tokens.out=612 finish=stop
[2026-05-01T08:14:39.001Z] [agent] approval requested cmd=rm payload.size=128
[2026-05-01T08:14:42.554Z] [agent] approval granted by=alex scope=once
[2026-05-01T08:14:42.604Z] [agent] tool=run cmd="rm -rf .cache" ok 22ms
[2026-05-01T08:14:43.000Z] [agent] session checkpoint saved · 12kb`;
  return (
    <PhoneScreen>
      <NavBar title="Diagnostics" onBack={onBack} trailing={<NavIcon name="copy" />} />
      <Stack gap={10} style={{ padding: '0 16px 10px' }}>
        <SegControl options={[{ value: 'hermes', label: 'Hermes' }, { value: 'gateway', label: 'Gateway' }]} value={tab} onChange={setTab} />
        <Row gap={6} style={{ overflowX: 'auto' }}>
          {['agent', 'errors', 'mcp', 'cron', 'web'].map(f => (
            <Chip key={f} active={file === f} onClick={() => setFile(f)}>{f}</Chip>
          ))}
        </Row>
        <Row gap={8} align="center">
          <Input placeholder="Filter…" icon="search" onChange={() => {}} value="" />
        </Row>
        <Row gap={8} align="center" justify="space-between">
          <Row gap={6} align="center"><StatusDot kind="online" /><Text kind="caption" color={theme.ink3}>Tail · 5s</Text></Row>
          <Text kind="caption" mono color={theme.ink3}>{file}.log · 4.2 MB</Text>
        </Row>
      </Stack>
      <div style={{ flex: 1, overflow: 'auto', margin: '0 16px 80px', padding: 12, background: theme.sunken, borderRadius: 10, border: `1px solid ${theme.lineSoft}` }}>
        <pre style={{ margin: 0, fontFamily: theme.fonts.mono, fontSize: 11, lineHeight: '15px', color: theme.ink2, whiteSpace: 'pre' }}>{lines}</pre>
      </div>
    </PhoneScreen>
  );
}

// ─── Account & security ─────────────────────────────────────────
function AccountScreen({ onBack }) {
  const theme = window.__theme;
  return (
    <PhoneScreen>
      <NavBar title="Account & security" onBack={onBack} />
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={18}>
          <ListGroup header="Identity">
            <ListRow icon="user" title="Username" detail="alex" />
            <ListRow icon="key" title="Change password" chevron />
          </ListGroup>
          <ListGroup header="Active sessions" footer="Each row is a refresh token. Revoke to sign that device out.">
            <ListRow icon="user" iconColor={theme.accentBg} title="iPhone 15 Pro · this device" subtitle="seen 2m ago · NYC" right={<Text kind="caption" color={theme.positive} style={{ marginRight: 4 }}>active</Text>} />
            <ListRow icon="user" title="iPad Pro" subtitle="seen 3d ago · NYC" right={<Text kind="caption" color={theme.danger} style={{ marginRight: 4 }}>Revoke</Text>} />
            <ListRow icon="user" title="MacBook Air" subtitle="seen 14d ago · Berlin" right={<Text kind="caption" color={theme.danger} style={{ marginRight: 4 }}>Revoke</Text>} />
          </ListGroup>
          <ListGroup header="Device">
            <ListRow icon="shieldCheck" title="Biometric unlock" right={<Toggle on={true} onChange={() => {}} />} />
          </ListGroup>
          <ListGroup>
            <ListRow icon="chevR" iconColor={theme.danger + '22'} title="Sign out everywhere" danger />
          </ListGroup>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

// ─── About ──────────────────────────────────────────────────────
function AboutScreen({ onBack }) {
  const theme = window.__theme;
  return (
    <PhoneScreen>
      <NavBar title="About" onBack={onBack} />
      <Stack gap={24} style={{ padding: '20px 16px' }}>
        <Stack gap={14} style={{ alignItems: 'center', textAlign: 'center' }}>
          <HermesMark size={48} />
          <Stack gap={4} style={{ alignItems: 'center' }}>
            <Text kind="h1">Hermes</Text>
            <Text kind="caption" mono color={theme.ink3}>mobile · 1.4.2 (1842)</Text>
          </Stack>
        </Stack>
        <ListGroup header="Versions">
          <ListRow icon="bolt" title="App" detail="1.4.2 · build 1842" />
          <ListRow icon="terminal" title="Hermes core" detail="0.18.5" />
          <ListRow icon="globe" title="Gateway" detail="1.4.3" />
          <ListRow icon="hash" title="Commit" detail="a4e2c91" />
        </ListGroup>
        <ListGroup>
          <ListRow icon="doc" title="Acknowledgements" chevron />
          <ListRow icon="shieldCheck" title="Privacy policy" chevron />
          <ListRow icon="doc" title="Terms" chevron />
          <ListRow icon="refresh" title="Reset onboarding" chevron />
        </ListGroup>
      </Stack>
    </PhoneScreen>
  );
}

// ─── Usage / analytics ──────────────────────────────────────────
function UsageScreen({ onBack }) {
  const theme = window.__theme;
  const [range, setRange] = useS3('30d');
  // 30 day cost data
  const days = Array.from({ length: 30 }, (_, i) => {
    const v = 0.4 + Math.sin(i * 0.43) * 0.3 + (i / 30) * 0.6 + (Math.random() - 0.5) * 0.2;
    return Math.max(0.05, v);
  });
  const max = Math.max(...days);
  return (
    <PhoneScreen>
      <NavBar title="Usage" onBack={onBack} />
      <Stack gap={18} style={{ padding: '8px 16px 20px', flex: 1, overflowY: 'auto' }}>
        <SegControl options={[{ value: '7d', label: '7 days' }, { value: '30d', label: '30 days' }, { value: '90d', label: '90 days' }]} value={range} onChange={setRange} />
        <div style={{ padding: 16, background: theme.surface, borderRadius: 14, border: `1px solid ${theme.line}` }}>
          <Stack gap={4}>
            <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Total · 30 days</Text>
            <Row align="baseline" gap={8}><Text kind="display" mono>$24.18</Text><Text kind="caption" color={theme.positive}>−12% vs prior</Text></Row>
            <Text kind="caption" color={theme.ink3} mono>4.2M in · 612k out · 1.8M cached</Text>
          </Stack>
          <div style={{ height: 110, marginTop: 18, display: 'flex', alignItems: 'flex-end', gap: 3 }}>
            {days.map((d, i) => (
              <div key={i} style={{
                flex: 1, height: `${(d / max) * 100}%`, borderRadius: 2,
                background: i === days.length - 1 ? theme.accent : theme.ink2 + '88',
              }}/>
            ))}
          </div>
          <Row justify="space-between" style={{ marginTop: 6 }}>
            <Text kind="caption" mono color={theme.ink3}>Apr 1</Text>
            <Text kind="caption" mono color={theme.ink3}>May 1</Text>
          </Row>
        </div>
        <ListGroup header="By model">
          <ModelCostRow name="gpt-5" pct={0.62} cost="$15.02" />
          <ModelCostRow name="claude-opus-4.5" pct={0.21} cost="$5.06" />
          <ModelCostRow name="gpt-5-mini" pct={0.10} cost="$2.41" />
          <ModelCostRow name="gemini-2.5-pro" pct={0.07} cost="$1.69" />
        </ListGroup>
        <ListGroup header="Top sessions">
          <ListRow icon="terminal" title="Refactor cron output dispatch" subtitle="gpt-5 · 18 turns" detail="$3.24" chevron />
          <ListRow icon="terminal" title="docs.hermes.dev redesign" subtitle="claude-opus · 9 turns" detail="$2.10" chevron />
          <ListRow icon="terminal" title="iOS build cert rotation" subtitle="gpt-5 · 4 turns" detail="$1.72" chevron />
        </ListGroup>
      </Stack>
    </PhoneScreen>
  );
}
function ModelCostRow({ name, pct, cost }) {
  const theme = window.__theme;
  return (
    <div style={{ padding: '12px 16px' }}>
      <Row justify="space-between" align="baseline" style={{ marginBottom: 6 }}>
        <Text kind="body" mono>{name}</Text>
        <Text kind="body" mono>{cost}</Text>
      </Row>
      <ProgressBar value={pct} />
    </div>
  );
}

// ─── Tools & toolsets ───────────────────────────────────────────
function ToolsScreen({ onBack }) {
  const theme = window.__theme;
  const sets = [
    { id: 'code', name: 'Code', enabled: true, count: 12, hint: 'edit, grep, run, format', need: null },
    { id: 'web', name: 'Web', enabled: true, count: 6, hint: 'fetch, scrape, search', need: null },
    { id: 'ops', name: 'Ops', enabled: true, count: 8, hint: 'ssh, docker, k8s', need: 'GITHUB_TOKEN' },
    { id: 'voice', name: 'Voice', enabled: false, count: 4, hint: 'stt, tts, record', need: null },
    { id: 'research', name: 'Research', enabled: false, count: 5, hint: 'arxiv, scholar, summarize', need: null },
  ];
  return (
    <PhoneScreen>
      <NavBar title="Tools" onBack={onBack} />
      <ListGroup>
        {sets.map(s => (
          <ListRow key={s.id} icon="bolt" iconColor={s.enabled ? theme.accentBg : theme.chip}
            title={s.name} subtitle={`${s.count} tools · ${s.hint}`}
            right={
              <Row gap={8} align="center">
                {s.need && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: theme.warning + '22', color: theme.warning, fontFamily: theme.fonts.mono }}>needs {s.need}</span>}
                <Toggle on={s.enabled} onChange={() => {}} />
              </Row>
            } />
        ))}
      </ListGroup>
    </PhoneScreen>
  );
}

// ─── Skills ─────────────────────────────────────────────────────
function SkillsScreen({ onBack }) {
  const theme = window.__theme;
  const [q, setQ] = useS3('');
  const skills = [
    { name: 'pr-review', src: 'built-in', desc: 'Walks through a GitHub PR diff and proposes review comments.' },
    { name: 'rubber-duck', src: 'built-in', desc: 'Asks clarifying questions before generating code.' },
    { name: 'standup-digest', src: 'auto', desc: 'Summarizes a Slack channel into a standup digest.' },
    { name: 'sql-explain', src: 'user', desc: 'Walks through a SQL plan and suggests indexes.' },
    { name: 'commit-msg', src: 'built-in', desc: 'Writes Conventional Commits messages from a diff.' },
    { name: 'release-notes', src: 'auto', desc: 'Drafts a CHANGELOG entry from a range of commits.' },
  ];
  const visible = skills.filter(s => s.name.includes(q.toLowerCase()) || s.desc.toLowerCase().includes(q.toLowerCase()));
  return (
    <PhoneScreen>
      <NavBar title="Skills" onBack={onBack} />
      <Stack gap={10} style={{ padding: '4px 16px 12px' }}>
        <Input value={q} onChange={setQ} icon="search" placeholder="Search skills" />
        <Row gap={6}><Chip active>All · {skills.length}</Chip><Chip>Built-in</Chip><Chip>User</Chip><Chip>Auto-saved</Chip></Row>
      </Stack>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <ListGroup>
          {visible.map(s => (
            <ListRow key={s.name} icon="hash" iconColor={s.src === 'built-in' ? theme.accentBg : theme.chip}
              title={s.name} subtitle={s.desc}
              right={<span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: theme.chip, color: theme.ink2, fontFamily: theme.fonts.mono, marginRight: 6 }}>{s.src}</span>}
              chevron />
          ))}
        </ListGroup>
      </div>
    </PhoneScreen>
  );
}

Object.assign(window, {
  SettingsIndex, ModelPicker, KeysScreen, KeyEditor, VisionScreen, AuxScreen,
  NotificationsScreen, StorageScreen, LogsScreen, AccountScreen, AboutScreen,
  UsageScreen, ToolsScreen, SkillsScreen,
});
