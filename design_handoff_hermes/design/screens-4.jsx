// Hermes screens — part 4: onboarding flow + tool detail + approval modal

const { useState: useS4 } = React;

function OnboardingFlow({ onBack, step: stepProp = 0 }) {
  const theme = window.__theme;
  const [step, setStep] = useS4(stepProp);
  const next = () => setStep(s => Math.min(s + 1, 4));
  const prev = () => setStep(s => Math.max(s - 1, 0));

  return (
    <PhoneScreen>
      {/* Progress dots */}
      <div style={{ position: 'absolute', top: 60, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 6, zIndex: 5 }}>
        {[0,1,2,3,4].map(i => (
          <div key={i} style={{ width: i === step ? 18 : 6, height: 6, borderRadius: 3, background: i <= step ? theme.ink : theme.line, transition: 'all 220ms' }} />
        ))}
      </div>
      <div style={{ paddingTop: 96, flex: 1, display: 'flex', flexDirection: 'column' }}>
        {step === 0 && <OBWelcome />}
        {step === 1 && <OBServer />}
        {step === 2 && <OBSignIn />}
        {step === 3 && <OBNotifications />}
        {step === 4 && <OBDone />}
      </div>
      <div style={{ padding: '12px 16px 40px', display: 'flex', gap: 8 }}>
        {step > 0 && step < 4 && <Button kind="secondary" onClick={prev}>Back</Button>}
        {step < 3 && <Button kind="accent" full onClick={next} rightIcon="chevR">Continue</Button>}
        {step === 3 && <Button kind="accent" full onClick={next} leftIcon="bell">Enable notifications</Button>}
        {step === 3 && <Button kind="ghost" onClick={next}>Skip</Button>}
        {step === 4 && <Button kind="accent" full onClick={onBack} rightIcon="chevR">Start a chat</Button>}
      </div>
    </PhoneScreen>
  );
}

function OBWelcome() {
  const theme = window.__theme;
  return (
    <Stack gap={28} style={{ padding: '40px 24px', flex: 1, justifyContent: 'center' }}>
      <Stack gap={20} style={{ alignItems: 'flex-start' }}>
        <HermesMark size={44} />
        <Stack gap={10}>
          <Text kind="display" style={{ lineHeight: '38px' }}>Talk to your agent from anywhere.</Text>
          <Text kind="bodyLg" color={theme.ink3}>Hermes runs on your gateway. This app is a thin client — your data, keys, and workdirs stay on your hardware.</Text>
        </Stack>
      </Stack>
      <Stack gap={12}>
        <FeatureRow icon="terminal" title="Chat with tools" body="Code, grep, run — Hermes uses tools, you approve." />
        <FeatureRow icon="clock" title="Schedule jobs" body="Cron sends results back as push notifications." />
        <FeatureRow icon="shieldCheck" title="Yours alone" body="JWT auth, end-to-end via your own gateway." />
      </Stack>
    </Stack>
  );
}
function FeatureRow({ icon, title, body }) {
  const theme = window.__theme;
  return (
    <Row gap={12} align="flex-start">
      <div style={{ width: 32, height: 32, borderRadius: 10, background: theme.chip, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: theme.ink2 }}>
        <Icon name={icon} size={16} />
      </div>
      <Stack gap={2}>
        <Text kind="label">{title}</Text>
        <Text kind="caption" color={theme.ink3}>{body}</Text>
      </Stack>
    </Row>
  );
}

function OBServer() {
  const theme = window.__theme;
  const [url, setUrl] = useS4('https://hermes.alex.dev:8443');
  return (
    <Stack gap={24} style={{ padding: '20px 24px', flex: 1 }}>
      <Stack gap={8}>
        <Text kind="h1">Connect to your gateway.</Text>
        <Text kind="body" color={theme.ink3}>The URL where your Hermes gateway is reachable.</Text>
      </Stack>
      <Field label="Gateway URL"><Input value={url} onChange={setUrl} mono icon="globe" /></Field>
      <div style={{ padding: 14, background: theme.surface, borderRadius: 12, border: `1px solid ${theme.line}` }}>
        <Row gap={10} align="center">
          <div style={{ width: 32, height: 32, borderRadius: 16, background: theme.positive + '22', color: theme.positive, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check" size={16} />
          </div>
          <Stack gap={2} style={{ flex: 1 }}>
            <Text kind="label">Reachable</Text>
            <Text kind="caption" mono color={theme.ink3}>v0.18.5 · 142ms · TLS valid</Text>
          </Stack>
          <Button kind="ghost" size="sm" leftIcon="refresh">Test</Button>
        </Row>
      </div>
    </Stack>
  );
}

function OBSignIn() {
  const theme = window.__theme;
  return (
    <Stack gap={24} style={{ padding: '20px 24px', flex: 1 }}>
      <Stack gap={8}>
        <Text kind="h1">First sign in.</Text>
        <Text kind="body" color={theme.ink3}>Use the credentials you set during gateway bootstrap.</Text>
      </Stack>
      <Stack gap={14}>
        <Field label="Username"><Input value="alex" onChange={() => {}} icon="user" /></Field>
        <Field label="Password" hint="Used to derive your local key. Store it somewhere safe.">
          <Input value="hermes-mvp-2026" onChange={() => {}} type="password" icon="key" />
        </Field>
      </Stack>
    </Stack>
  );
}

function OBNotifications() {
  const theme = window.__theme;
  return (
    <Stack gap={28} style={{ padding: '40px 24px', flex: 1, justifyContent: 'center', alignItems: 'flex-start' }}>
      <div style={{ width: 64, height: 64, borderRadius: 20, background: theme.accentBg, color: theme.accent, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="bell" size={28} />
      </div>
      <Stack gap={10}>
        <Text kind="h1" style={{ lineHeight: '32px' }}>Get pinged when jobs finish.</Text>
        <Text kind="bodyLg" color={theme.ink3}>We'll notify you on cron completions and approval requests. You can change this anytime.</Text>
      </Stack>
      <Stack gap={8} style={{ width: '100%' }}>
        <SampleNotif title="Daily standup digest" body="4 updates from #eng-mobile, 2 blockers." time="now" />
        <SampleNotif title="Approval requested" body="rm -rf .cache · runs outside session workdir." time="2m" />
      </Stack>
    </Stack>
  );
}
function SampleNotif({ title, body, time }) {
  const theme = window.__theme;
  return (
    <div style={{ padding: 12, background: theme.surface, borderRadius: 14, border: `1px solid ${theme.line}` }}>
      <Row gap={10} align="flex-start">
        <HermesMark size={28} />
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Row justify="space-between" align="baseline">
            <Text kind="label">HERMES</Text>
            <Text kind="caption" color={theme.ink3} mono>{time}</Text>
          </Row>
          <Text kind="bodyLg" style={{ fontWeight: 600 }}>{title}</Text>
          <Text kind="caption" color={theme.ink2}>{body}</Text>
        </Stack>
      </Row>
    </div>
  );
}

function OBDone() {
  const theme = window.__theme;
  return (
    <Stack gap={24} style={{ padding: '60px 24px', flex: 1, justifyContent: 'center', alignItems: 'center', textAlign: 'center' }}>
      <div style={{ width: 80, height: 80, borderRadius: 40, background: theme.positive + '22', color: theme.positive, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="check" size={36} stroke={2.5} />
      </div>
      <Stack gap={10} style={{ alignItems: 'center' }}>
        <Text kind="display">You're set.</Text>
        <Text kind="bodyLg" color={theme.ink3}>Connected to <span style={{ fontFamily: theme.fonts.mono }}>hermes.alex.dev</span>.</Text>
      </Stack>
    </Stack>
  );
}

// ─── Tool call detail modal ─────────────────────────────────────
function ToolDetailScreen({ onBack }) {
  const theme = window.__theme;
  return (
    <PhoneScreen>
      <NavBar title="Tool call" onBack={onBack} trailing={<NavIcon name="copy" />} />
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 60 }}>
        <Stack gap={18} style={{ padding: '8px 0' }}>
          <div style={{ margin: '0 16px', padding: 14, background: theme.surface, borderRadius: 12, border: `1px solid ${theme.line}` }}>
            <Row justify="space-between" align="flex-start">
              <Stack gap={4}>
                <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Tool</Text>
                <Text kind="h2" mono>edit_file</Text>
                <Text kind="caption" mono color={theme.ink3}>app/(app)/settings/keys/index.tsx</Text>
              </Stack>
              <StatusPill kind="online" label="ok · 142ms" />
            </Row>
          </div>
          <Section title="Args">
            <div style={{ margin: '0 16px' }}>
              <MonoBlock>{`{
  "path": "app/(app)/settings/keys/index.tsx",
  "edits": [
    { "old": "const SET_KEYS = []", "new": "const SET_KEYS = ['openai']" }
  ]
}`}</MonoBlock>
            </div>
          </Section>
          <Section title="Diff">
            <div style={{ margin: '0 16px', borderRadius: 10, overflow: 'hidden', background: theme.sunken, border: `1px solid ${theme.lineSoft}` }}>
              <DiffLine kind="ctx" no="14" text="export function KeysScreen() {" />
              <DiffLine kind="del" no="15" text="  const SET_KEYS = []" />
              <DiffLine kind="add" no="15" text="  const SET_KEYS = ['openai']" />
              <DiffLine kind="ctx" no="16" text="  const [q, setQ] = useState('')" />
              <DiffLine kind="ctx" no="17" text="  return (" />
            </div>
          </Section>
        </Stack>
      </div>
    </PhoneScreen>
  );
}
function DiffLine({ kind, no, text }) {
  const theme = window.__theme;
  const bg = kind === 'add' ? theme.positive + '20' : kind === 'del' ? theme.danger + '18' : 'transparent';
  const sym = kind === 'add' ? '+' : kind === 'del' ? '−' : ' ';
  const symColor = kind === 'add' ? theme.positive : kind === 'del' ? theme.danger : theme.ink3;
  return (
    <div style={{ display: 'flex', background: bg, padding: '2px 0', fontFamily: theme.fonts.mono, fontSize: 11, lineHeight: '17px' }}>
      <span style={{ width: 28, textAlign: 'right', color: theme.ink3, paddingRight: 6 }}>{no}</span>
      <span style={{ width: 14, color: symColor }}>{sym}</span>
      <span style={{ flex: 1, color: theme.ink2, whiteSpace: 'pre' }}>{text}</span>
    </div>
  );
}

// ─── Approval modal (full-screen) ───────────────────────────────
function ApprovalModal({ onBack }) {
  const theme = window.__theme;
  return (
    <PhoneScreen>
      <NavBar title="Approval" onBack={onBack} />
      <Stack gap={20} style={{ padding: '8px 16px 24px', flex: 1 }}>
        <div style={{ padding: 14, background: theme.warning + '14', borderRadius: 12, border: `1px solid ${theme.warning}55` }}>
          <Row gap={10} align="center">
            <Icon name="shield" size={18} color={theme.warning} />
            <Stack gap={2}>
              <Text kind="label" color={theme.warning}>Destructive command</Text>
              <Text kind="caption" color={theme.ink2}>Hermes wants to run a command outside the session workdir.</Text>
            </Stack>
          </Row>
        </div>
        <Stack gap={4}>
          <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>Command</Text>
          <MonoBlock>$ rm -rf app/(app)/settings/keys/.cache</MonoBlock>
        </Stack>
        <Stack gap={4}>
          <Text kind="micro" color={theme.ink3} style={{ textTransform: 'uppercase' }}>From session</Text>
          <Text kind="body">Refactor cron output dispatch · turn 14</Text>
        </Stack>
        <Field label="Reason (optional)">
          <Input value="" onChange={() => {}} placeholder="Why are you approving / denying?" />
        </Field>
        <div style={{ flex: 1 }} />
        <Stack gap={8}>
          <Button kind="accent" size="lg" full leftIcon="check">Approve once</Button>
          <Button kind="secondary" size="lg" full>Approve all in this session</Button>
          <Button kind="danger" size="lg" full leftIcon="close">Deny</Button>
        </Stack>
      </Stack>
    </PhoneScreen>
  );
}

Object.assign(window, { OnboardingFlow, ToolDetailScreen, ApprovalModal });
