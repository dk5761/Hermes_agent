// Hermes screens — part 2: cron, sessions search, image lightbox

const { useState: useS2 } = React;

const MOCK_JOBS = [
  { id: 'j1', name: 'Daily standup digest', schedule: '0 9 * * 1-5', scheduleDisplay: 'Weekdays · 9:00', last: '14h ago', state: 'enabled', notify: true, deliver: 'telegram', next: 'tomorrow · 9:00' },
  { id: 'j2', name: 'GitHub PR review queue', schedule: '*/30 * * * *', scheduleDisplay: 'Every 30 min', last: '4m ago', state: 'enabled', notify: true, deliver: 'origin', next: 'in 26m', running: true },
  { id: 'j3', name: 'Refresh models.dev cache', schedule: '0 */6 * * *', scheduleDisplay: 'Every 6 hours', last: '2h ago', state: 'enabled', notify: false, deliver: 'local' },
  { id: 'j4', name: 'Weekly cost rollup', schedule: '0 18 * * 5', scheduleDisplay: 'Fridays · 18:00', last: '3d ago', state: 'paused', notify: true, deliver: 'telegram' },
  { id: 'j5', name: 'Server uptime ping', schedule: '*/5 * * * *', scheduleDisplay: 'Every 5 min', last: '40s ago', state: 'enabled', notify: false, deliver: 'local' },
];

const MOCK_OUTPUTS = [
  { id: 'o1', ts: 'Today · 09:00', preview: 'Standup digest — 4 updates from #eng-mobile, 2 blockers, 0 deploys.' },
  { id: 'o2', ts: 'Yesterday · 09:00', preview: 'Standup digest — 3 updates, 1 blocker on iOS push tokens, deploy 1.4.2.' },
  { id: 'o3', ts: 'Mon · 09:00', preview: 'Standup digest — 5 updates, 0 blockers, weekend deploys clean.' },
  { id: 'o4', ts: 'Apr 24 · 09:00', preview: 'Standup digest — pushed cron output dispatch fix, all green.' },
];

function CronList({ onOpen, onNew, onBack }) {
  const theme = window.__theme;
  const [filter, setFilter] = useS2('all');
  const visible = MOCK_JOBS.filter(j => filter === 'all' || (filter === 'enabled' && j.state === 'enabled') || (filter === 'paused' && j.state === 'paused'));
  return (
    <PhoneScreen>
      <NavBar large title="Cron" subtitle={`${MOCK_JOBS.length} jobs · 1 running`} onBack={onBack}
        trailing={<NavIcon name="plus" onClick={onNew} />} />
      <Row gap={6} style={{ padding: '0 16px 12px', overflowX: 'auto' }}>
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>All</Chip>
        <Chip active={filter === 'enabled'} onClick={() => setFilter('enabled')}>Enabled · 4</Chip>
        <Chip active={filter === 'paused'} onClick={() => setFilter('paused')}>Paused · 1</Chip>
        <Chip>Notify on</Chip>
        <Chip>Sort: name</Chip>
      </Row>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        {visible.map((j, i) => (
          <div key={j.id} onClick={() => onOpen && onOpen(j)} style={{
            padding: '14px 16px', display: 'flex', gap: 12, alignItems: 'flex-start',
            borderBottom: i < visible.length - 1 ? `1px solid ${theme.lineSoft}` : 'none',
            cursor: 'pointer',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: j.running ? theme.accentBg : theme.chip,
              color: j.running ? theme.accent : theme.ink2,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: j.running ? `1px solid ${theme.accent}55` : 'none',
            }}>
              <Icon name="clock" size={16} />
            </div>
            <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
              <Row justify="space-between" align="baseline" gap={8}>
                <Text kind="bodyLg" style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.name}</Text>
                <Row gap={6} align="center">
                  {j.notify && <Icon name="bell" size={11} color={theme.ink3} />}
                  <Text kind="caption" color={theme.ink3} mono>{j.last}</Text>
                </Row>
              </Row>
              <Row gap={6} align="center">
                <Text kind="caption" mono color={theme.ink3}>{j.schedule}</Text>
                <Text kind="caption" color={theme.ink3}>·</Text>
                <Text kind="caption" color={theme.ink3}>{j.scheduleDisplay}</Text>
              </Row>
              <Row gap={6} style={{ marginTop: 4 }}>
                {j.running && <StatusPill kind="connecting" label="running · 4s" />}
                {j.state === 'paused' && <StatusPill kind="paused" label="paused" />}
                {j.state === 'enabled' && !j.running && <StatusPill kind="online" label={`next ${j.next || 'soon'}`} />}
              </Row>
            </Stack>
          </div>
        ))}
      </div>
    </PhoneScreen>
  );
}

function CronDetail({ job, onBack, onOutput }) {
  const theme = window.__theme;
  const j = job || MOCK_JOBS[0];
  const [notify, setNotify] = useS2(j.notify);
  const [paused, setPaused] = useS2(j.state === 'paused');
  return (
    <PhoneScreen>
      <NavBar title={j.name} onBack={onBack} trailing={<NavIcon name="edit" />} />
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={20} style={{ padding: '8px 0 24px' }}>
          {/* Hero card */}
          <div style={{ margin: '0 16px', padding: 16, background: theme.surface, borderRadius: 14, border: `1px solid ${theme.line}` }}>
            <Row justify="space-between" align="flex-start">
              <Stack gap={4}>
                <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Schedule</Text>
                <Text kind="h2">{j.scheduleDisplay}</Text>
                <Text kind="caption" mono color={theme.ink3}>{j.schedule}</Text>
              </Stack>
              {paused
                ? <StatusPill kind="paused" label="paused" />
                : <StatusPill kind="online" label="enabled" />}
            </Row>
            <div style={{ height: 1, background: theme.lineSoft, margin: '14px 0' }} />
            <Stack gap={8}>
              <Row justify="space-between"><Text kind="caption" color={theme.ink3}>Next run</Text><Text kind="caption" mono>{j.next || 'tomorrow · 09:00'}</Text></Row>
              <Row justify="space-between"><Text kind="caption" color={theme.ink3}>Last run</Text><Text kind="caption" mono>{j.last}</Text></Row>
              <Row justify="space-between"><Text kind="caption" color={theme.ink3}>Model</Text><Text kind="caption" mono>auto · gpt-5</Text></Row>
              <Row justify="space-between"><Text kind="caption" color={theme.ink3}>Deliver to</Text><Text kind="caption" mono>{j.deliver}</Text></Row>
            </Stack>
          </div>
          {/* Actions */}
          <Row gap={8} style={{ padding: '0 16px' }}>
            <Button kind="secondary" full leftIcon={paused ? 'play' : 'pause'} onClick={() => setPaused(p => !p)}>{paused ? 'Resume' : 'Pause'}</Button>
            <Button kind="primary" full leftIcon="bolt">Run now</Button>
          </Row>
          {/* Prompt */}
          <Section title="Prompt">
            <div style={{ margin: '0 16px' }}>
              <MonoBlock>{`Summarize today's standup updates from #eng-mobile.
Group by author. Pull blockers to the top.
Note any deploys merged in the last 24h.`}</MonoBlock>
            </div>
          </Section>
          {/* Notify */}
          <ListGroup>
            <ListRow icon="bell" iconColor={theme.chip} title="Notify on completion" subtitle="Push to all signed-in devices" right={<Toggle on={notify} onChange={setNotify} />} />
          </ListGroup>
          {/* Outputs */}
          <Section title="Recent runs" action={<Text kind="caption" color={theme.accent}>See all</Text>}>
            <Stack gap={1} style={{ background: theme.surface, margin: '0 16px', borderRadius: 14, border: `1px solid ${theme.line}`, overflow: 'hidden' }}>
              {MOCK_OUTPUTS.map((o, i) => (
                <div key={o.id} onClick={() => onOutput && onOutput(o)} style={{
                  padding: '12px 14px', cursor: 'pointer',
                  borderBottom: i < MOCK_OUTPUTS.length - 1 ? `1px solid ${theme.lineSoft}` : 'none',
                }}>
                  <Row justify="space-between" align="center">
                    <Text kind="caption" mono color={theme.ink3}>{o.ts}</Text>
                    <Icon name="chevR" size={14} color={theme.ink3} />
                  </Row>
                  <Text kind="body" style={{ display: 'block', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.preview}</Text>
                </div>
              ))}
            </Stack>
          </Section>
          {/* Danger */}
          <ListGroup>
            <ListRow icon="trash" iconColor={theme.danger + '22'} title="Delete job" danger />
          </ListGroup>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

function CronOutput({ output, job, onBack }) {
  const theme = window.__theme;
  return (
    <PhoneScreen>
      <NavBar title={output?.ts || 'Output'} onBack={onBack}
        trailing={<><NavIcon name="copy" /><NavIcon name="share" /></>} />
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px 60px' }}>
        <Stack gap={6} style={{ marginBottom: 16, padding: '8px 12px', background: theme.surface, borderRadius: 10, border: `1px solid ${theme.line}` }}>
          <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>From job</Text>
          <Row gap={8} align="center">
            <Icon name="clock" size={14} color={theme.ink3}/>
            <Text kind="caption">{job?.name || 'Daily standup digest'}</Text>
          </Row>
        </Stack>
        <Text kind="h2" style={{ display: 'block', marginBottom: 12 }}>Standup digest — May 1</Text>
        <Stack gap={14}>
          <Stack gap={4}>
            <Text kind="micro" color={theme.warning} style={{ textTransform: 'uppercase' }}>Blockers · 2</Text>
            <Text kind="body">@miri — iOS push tokens not registering on cold start after upgrade. Investigating Expo SDK 51 → 53 diff.</Text>
            <Text kind="body">@kev — Cron output dispatch dropping `deliver` target on retries. Has a fix branch.</Text>
          </Stack>
          <Stack gap={4}>
            <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Updates</Text>
            <Text kind="body">@alex — Shipped sessions FTS5 upgrade, 38% faster on the search benchmark.</Text>
            <Text kind="body">@sam — Models.dev cache now refreshes hourly. Vision picker shows 12 new providers.</Text>
            <Text kind="body">@li — Settings/storage screen wireframe up for review.</Text>
          </Stack>
          <Stack gap={4}>
            <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Deploys · last 24h</Text>
            <MonoBlock>{`gateway 1.4.2 → 1.4.3   ✓ 02:14 UTC
hermes  0.18.4 → 0.18.5  ✓ 04:30 UTC`}</MonoBlock>
          </Stack>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

function CronEditor({ onBack, jobId }) {
  const theme = window.__theme;
  const [name, setName] = useS2(jobId ? 'Daily standup digest' : '');
  const [prompt, setPrompt] = useS2(jobId ? "Summarize today's standup updates from #eng-mobile." : '');
  const [cron, setCron] = useS2(jobId ? '0 9 * * 1-5' : '0 9 * * *');
  const [preset, setPreset] = useS2(jobId ? 'weekdays-9' : 'daily-9');
  const presets = [
    { id: 'every-hour', label: 'Every hour', cron: '0 * * * *' },
    { id: 'daily-9', label: 'Daily · 9am', cron: '0 9 * * *' },
    { id: 'weekdays-9', label: 'Weekdays · 9am', cron: '0 9 * * 1-5' },
    { id: 'weekly-fri', label: 'Fridays · 6pm', cron: '0 18 * * 5' },
  ];
  return (
    <PhoneScreen>
      <NavBar title={jobId ? 'Edit job' : 'New cron job'} onBack={onBack}
        leading={<button onClick={onBack} style={{ background: 'transparent', border: 'none', color: theme.accent, fontSize: 15, cursor: 'pointer', padding: 6, marginLeft: -6 }}>Cancel</button>}
        trailing={<button style={{ background: 'transparent', border: 'none', color: theme.accent, fontSize: 15, fontWeight: 600, cursor: 'pointer', padding: 6 }}>Save</button>}
      />
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={20} style={{ padding: '12px 0' }}>
          <Stack gap={12} style={{ padding: '0 16px' }}>
            <Field label="Name"><Input value={name} onChange={setName} placeholder="Daily standup digest" /></Field>
            <Field label="Prompt" hint="What should Hermes do on each run?">
              <textarea value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe the task…" rows={5} style={{
                width: '100%', padding: 12, borderRadius: 10, border: `1px solid ${theme.line}`,
                background: theme.surface, color: theme.ink, resize: 'none',
                fontFamily: theme.fonts.body, fontSize: 15, lineHeight: '20px', boxSizing: 'border-box',
              }}/>
            </Field>
          </Stack>

          <Section title="Schedule">
            <Stack gap={10} style={{ padding: '0 16px' }}>
              <Row gap={6} style={{ flexWrap: 'wrap' }}>
                {presets.map(p => (
                  <Chip key={p.id} active={preset === p.id} onClick={() => { setPreset(p.id); setCron(p.cron); }}>{p.label}</Chip>
                ))}
              </Row>
              <Field label="Cron expression">
                <Input value={cron} onChange={setCron} mono />
              </Field>
              <div style={{ padding: 12, background: theme.surface, borderRadius: 10, border: `1px solid ${theme.line}` }}>
                <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase', display: 'block', marginBottom: 6 }}>Next 3 runs</Text>
                <Stack gap={4}>
                  <Text kind="caption" mono>tomorrow · 09:00 (UTC+2)</Text>
                  <Text kind="caption" mono>Sat · 09:00</Text>
                  <Text kind="caption" mono>Mon · 09:00</Text>
                </Stack>
              </div>
            </Stack>
          </Section>

          <ListGroup header="Run config">
            <ListRow icon="spark" title="Model" detail="auto · gpt-5" chevron />
            <ListRow icon="bolt" title="Toolsets" detail="3 enabled" chevron />
            <ListRow icon="share" title="Deliver to" detail="origin" chevron />
            <ListRow icon="refresh" title="Repeat" detail="forever" chevron />
            <ListRow icon="terminal" title="Workdir" detail="~/work/digest" chevron />
          </ListGroup>

          <ListGroup>
            <ListRow icon="bell" iconColor={theme.chip} title="Notify on completion" right={<Toggle on={true} onChange={() => {}} />} />
          </ListGroup>
        </Stack>
      </div>
    </PhoneScreen>
  );
}

// ─── Sessions search ────────────────────────────────────────────
function SearchScreen({ onBack, onOpen }) {
  const theme = window.__theme;
  const [q, setQ] = useS2('cron output');
  const groups = [
    { session: 'Refactor cron output dispatch', when: '2m ago', hits: [
      { line: 14, text: 'cron output dispatch is still dropping the deliver target', match: [11, 25] },
      { line: 87, text: 'reproduces only when the cron output queue is non-empty at boot', match: [27, 38] },
    ]},
    { session: 'Hermes mobile screen audit', when: '14m ago', hits: [
      { line: 41, text: 'Cron output route exists but markdown rendering is partial', match: [5, 16] },
    ]},
    { session: 'Weekly digest', when: 'Mon', hits: [
      { line: 3, text: 'Top failure mode this week was cron output retry storms', match: [29, 39] },
    ]},
  ];
  const total = groups.reduce((s, g) => s + g.hits.length, 0);
  return (
    <PhoneScreen>
      <NavBar title="Search" onBack={onBack} />
      <Stack gap={10} style={{ padding: '4px 16px 12px' }}>
        <Input value={q} onChange={setQ} icon="search" placeholder="Search across all chats" autoFocus />
        <Row gap={6}>
          <Chip active>All time</Chip>
          <Chip>This week</Chip>
          <Chip>With files</Chip>
        </Row>
        <Text kind="caption" color={theme.ink3}>{total} matches · 3 sessions</Text>
      </Stack>
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        {groups.map((g, gi) => (
          <Stack key={gi} gap={6} style={{ marginBottom: 18 }}>
            <Row justify="space-between" align="center" style={{ padding: '0 16px' }}>
              <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>{g.session}</Text>
              <Text kind="caption" color={theme.ink3}>{g.when}</Text>
            </Row>
            <Stack gap={1} style={{ margin: '0 16px', background: theme.surface, borderRadius: 12, border: `1px solid ${theme.line}`, overflow: 'hidden' }}>
              {g.hits.map((h, hi) => (
                <div key={hi} onClick={() => onOpen && onOpen(g)} style={{
                  padding: '10px 12px', cursor: 'pointer',
                  borderBottom: hi < g.hits.length - 1 ? `1px solid ${theme.lineSoft}` : 'none',
                }}>
                  <Row gap={10} align="flex-start">
                    <Text kind="caption" mono color={theme.ink3} style={{ minWidth: 22 }}>{h.line}</Text>
                    <Text kind="body" style={{ flex: 1, lineHeight: '20px' }}>
                      {h.text.slice(0, h.match[0])}
                      <mark style={{ background: theme.accentBg, color: theme.accent, padding: '1px 2px', borderRadius: 3 }}>{h.text.slice(h.match[0], h.match[1])}</mark>
                      {h.text.slice(h.match[1])}
                    </Text>
                  </Row>
                </div>
              ))}
            </Stack>
          </Stack>
        ))}
      </div>
    </PhoneScreen>
  );
}

// ─── Image lightbox ─────────────────────────────────────────────
function ImageLightbox({ onClose }) {
  const theme = window.__theme;
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#000', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: '54px 16px 12px', display: 'flex', justifyContent: 'space-between', zIndex: 5,
        background: 'linear-gradient(180deg, rgba(0,0,0,0.6), transparent)' }}>
        <button onClick={onClose} style={{ width: 36, height: 36, borderRadius: 18, background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={20} />
        </button>
        <Stack gap={2} align="center" style={{ alignItems: 'center', textAlign: 'center', flex: 1 }}>
          <Text kind="label" color="#fff">screenshot.png</Text>
          <Text kind="caption" color="rgba(255,255,255,0.6)">2 of 4 · 1.2 MB</Text>
        </Stack>
        <button style={{ width: 36, height: 36, borderRadius: 18, background: 'rgba(255,255,255,0.12)', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="more" size={20} />
        </button>
      </div>
      {/* image */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{
          width: '88%', aspectRatio: '3/4', borderRadius: 6,
          background: `repeating-linear-gradient(135deg, #2a2a2e 0 12px, #232327 12px 24px)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Text kind="caption" mono color="rgba(255,255,255,0.4)">screenshot.png · 2048×2732</Text>
        </div>
      </div>
      {/* bottom actions */}
      <div style={{ position: 'absolute', bottom: 36, left: 0, right: 0, padding: '0 24px', display: 'flex', justifyContent: 'space-around', zIndex: 5 }}>
        <LBAction icon="download" label="Save" />
        <LBAction icon="share" label="Share" />
        <LBAction icon="copy" label="Copy" />
        <LBAction icon="trash" label="Delete" />
      </div>
    </div>
  );
}
function LBAction({ icon, label }) {
  return (
    <button style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <Icon name={icon} size={22} />
      <span style={{ fontSize: 11, opacity: 0.8 }}>{label}</span>
    </button>
  );
}

Object.assign(window, { CronList, CronDetail, CronOutput, CronEditor, SearchScreen, ImageLightbox });
