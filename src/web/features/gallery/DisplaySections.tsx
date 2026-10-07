/** Gallery: buttons, feedback (badges, chips, status, progress, skeleton), states, data display, memory, code, QR. */
import { useState, type ReactNode } from 'react'
import { Bell, BookOpen, Brain, Cpu, Download, FileText, HardDrive, Image, Laptop, Mic, Plus, SearchX, Settings, Smartphone, Sparkles, Trash2 } from 'lucide-react'
import { Accordion, Disclosure } from '../../components/Disclosure'
import { Avatar } from '../../components/Avatar'
import { Badge, Chip, LeavesPcBadge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Banner, Callout } from '../../components/Callout'
import { Card } from '../../components/Card'
import { CodeBlock } from '../../components/CodeBlock'
import { CopyButton } from '../../components/CopyButton'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { IconButton } from '../../components/IconButton'
import { Kbd } from '../../components/Kbd'
import { List, ListItem } from '../../components/List'
import { ProgressBar, ProgressRing } from '../../components/Progress'
import { QRCode } from '../../components/QRCode'
import { RememberedChip } from '../../components/RememberedChip'
import { Skeleton } from '../../components/Skeleton'
import { Spinner } from '../../components/Spinner'
import { StatusDot } from '../../components/StatusDot'
import { Switch } from '../../components/Switch'
import { toast } from '../../components/Toast'
import { Tooltip } from '../../components/Tooltip'
import { formatBytes } from '../../components/internal/files.logic'
import { apiError } from '@shared/errors'
import { Demo, Row, Section, Stack } from './Section'
import { NOW, PY_SAMPLE, RECALLED, TS_SAMPLE } from './sample'

export function ButtonsSection(): ReactNode {
  return (
    <Section id="buttons" title="Button · IconButton · Tooltip · Spinner · Kbd">
      <Demo label="Button: variants × sizes" wide>
        {(['sm', 'md', 'lg'] as const).map((size) => (
          <Row key={size}>
            <Button size={size} variant="primary" icon={<Plus />}>
              Primary
            </Button>
            <Button size={size}>Secondary</Button>
            <Button size={size} variant="ghost">
              Ghost
            </Button>
            <Button size={size} variant="danger" icon={<Trash2 />}>
              Danger
            </Button>
            <Button size={size} variant="primary" loading>
              Loading
            </Button>
            <Button size={size} disabled>
              Disabled
            </Button>
          </Row>
        ))}
      </Demo>
      <Demo label="IconButton · Tooltip · Spinner">
        <Row>
          <IconButton label="Settings" icon={<Settings />} />
          <IconButton label="Notifications" icon={<Bell />} variant="secondary" />
          <IconButton label="Add" icon={<Plus />} variant="primary" />
          <IconButton label="Delete" icon={<Trash2 />} variant="danger" />
          <IconButton label="Microphone on" icon={<Mic />} pressed />
          <IconButton label="Busy" icon={<Bell />} loading />
          <IconButton label="Large" icon={<Sparkles />} size="lg" variant="secondary" />
        </Row>
        <Row>
          <Tooltip content="A tooltip describing this button">
            <Button size="sm">Hover or focus me</Button>
          </Tooltip>
          <Spinner />
          <Spinner size={24} label="Loading" />
        </Row>
      </Demo>
      <Demo label="Kbd">
        <Row>
          <Kbd keys="Mod+K" />
          <Kbd keys="Mod+Shift+K" />
          <Kbd keys="Alt+ArrowUp" />
          <Kbd>Esc</Kbd>
          <Kbd keys="Enter" size="md" />
        </Row>
      </Demo>
    </Section>
  )
}

export function FeedbackSection(): ReactNode {
  const [filters, setFilters] = useState(['user'])
  const [chips, setChips] = useState(['itinerary.pdf', 'IMG_2041.jpg', 'Pasted text'])
  const toggle = (f: string): void => setFilters((cur) => (cur.includes(f) ? cur.filter((x) => x !== f) : [...cur, f]))
  return (
    <Section id="feedback" title="Badge · Chip · Status · Progress · Skeleton">
      <Demo label="Badge">
        <Row>
          <Badge>Neutral</Badge>
          <Badge tone="accent">New</Badge>
          <Badge tone="success" dot>
            Connected
          </Badge>
          <Badge tone="warning" dot>
            Indexing
          </Badge>
          <Badge tone="danger">Failed</Badge>
          <Badge tone="info" icon={<Image />}>
            Vision
          </Badge>
          <Badge tone="accent" solid>
            3
          </Badge>
          <Badge size="md" tone="success" icon={<HardDrive />}>
            On this PC
          </Badge>
          <LeavesPcBadge service="Voyage AI" />
        </Row>
      </Demo>
      <Demo label="Chip">
        <Row>
          {chips.map((c) => (
            <Chip key={c} icon={c.endsWith('.jpg') ? <Image /> : <FileText />} onRemove={() => setChips(chips.filter((x) => x !== c))} removeLabel={`Remove ${c}`}>
              {c}
            </Chip>
          ))}
          {chips.length === 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setChips(['itinerary.pdf', 'IMG_2041.jpg', 'Pasted text'])}>
              Reset chips
            </Button>
          ) : null}
        </Row>
        <Row>
          <Chip selected={filters.includes('user')} onClick={() => toggle('user')}>
            You
          </Chip>
          <Chip selected={filters.includes('ai')} onClick={() => toggle('ai')}>
            Vesper
          </Chip>
          <Chip tone="accent" icon={<Sparkles />} onClick={() => toast.info('Session #K7Q2MX')}>
            #K7Q2MX
          </Chip>
          <Chip size="sm">Small</Chip>
          <Chip disabled onClick={() => undefined}>
            Disabled
          </Chip>
        </Row>
      </Demo>
      <Demo label="StatusDot">
        <Row>
          <StatusDot status="online" label="Connected" showLabel />
          <StatusDot status="busy" label="Thinking" showLabel pulse />
          <StatusDot status="warning" label="Reconnecting" showLabel />
          <StatusDot status="error" label="Offline" showLabel />
          <StatusDot status="offline" label="Not paired" showLabel />
          <StatusDot status="live" label="Microphone live" showLabel pulse />
        </Row>
      </Demo>
      <Demo label="Progress">
        <Stack>
          <ProgressBar label="Parakeet TDT 0.6B (int8)" value={212e6 / 640e6} valueText={`${formatBytes(212e6)} of ${formatBytes(640e6)} · 8.4 MB/s`} />
          <ProgressBar label="Checking SHA-256…" tone="success" value={1} />
          <ProgressBar label="Indexing earlier messages" />
          <ProgressBar aria-label="Quota" value={0.92} tone="warning" size="sm" />
          <Row>
            <ProgressRing label="Uploading" value={0.42} />
            <ProgressRing label="Downloading" value={0.75} size={44} showValue />
            <ProgressRing label="Working" />
            <ProgressRing label="Failed" value={0.6} tone="danger" size={36} />
          </Row>
        </Stack>
      </Demo>
      <Demo label="Skeleton">
        <Row>
          <Skeleton variant="circle" width={36} />
          <div style={{ flex: 1, minWidth: 160 }}>
            <Skeleton lines={3} />
          </div>
        </Row>
        <Skeleton variant="rect" height={64} />
      </Demo>
    </Section>
  )
}

export function StatesSection(): ReactNode {
  const [banner, setBanner] = useState(true)
  return (
    <Section id="states" title="Empty · Error · Callout · Banner" description="07 D13: first run, empty results, per-error-code actions; privacy notes with verified sources (R21).">
      <Demo label="EmptyState (first run)">
        <EmptyState star size="lg" title="Good evening, Skye" description="Ask anything, or start with one of these." suggestions={['Plan my week', 'What did we talk about yesterday?', 'Help me write a message']} onSuggestion={(s) => toast.info(s)} />
      </Demo>
      <Demo label="EmptyState (no results)">
        <EmptyState size="sm" icon={<SearchX />} title="No chats match “tokyo”" description="Try fewer words, or search all sessions." actions={<Button size="sm">Search everywhere</Button>} />
      </Demo>
      <Demo label="ErrorState">
        <Stack>
          <ErrorState error="network" onRetry={() => toast.info('Retrying…')} />
          <ErrorState compact error={apiError('provider_auth')} onAction={() => toast.info('Would open Settings → AI providers')} />
          <ErrorState compact error={apiError('rate_limited', { retryAfter: 9 })} onRetry={() => toast.info('Retrying…')} />
        </Stack>
      </Demo>
      <Demo label="Callout" wide>
        <Stack>
          <Callout tone="privacy" title="What Voyage AI receives" learnMore={{ href: 'https://www.voyageai.com/privacy', label: 'Voyage privacy policy' }}>
            Message text is sent to embed it and to rank search results (up to 40 earlier messages per search). Voyage stores nothing for Vesper; your memory index stays on this PC.
          </Callout>
          <Callout tone="info" title="Tip">
            Press <Kbd keys="Mod+K" /> to search every chat.
          </Callout>
          <Callout tone="warning" title="Plain HTTP on your network" onDismiss={() => toast.info('Dismissed')}>
            The microphone needs HTTPS. Use Local network (HTTPS) or Tailscale.
          </Callout>
          <Callout tone="success">Your key works. 312 voices found.</Callout>
          <Callout tone="danger" title="Couldn't save" actions={<Button size="sm">Try again</Button>}>
            The disk is full.
          </Callout>
        </Stack>
      </Demo>
      <Demo label="Banner" wide>
        <Stack gap={8}>
          {banner ? (
            <Banner tone="danger" onDismiss={() => setBanner(false)} actions={<Button size="sm">Fix in Settings</Button>}>
              The AI service rejected the API key.
            </Banner>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setBanner(true)}>
              Show banner again
            </Button>
          )}
          <Banner tone="warning">Reconnecting…</Banner>
          <Banner tone="accent" actions={<Button size="sm">Turn off</Button>}>
            Public link is on — anyone with the link and your password can open Vesper. Turns off in 7 h 42 min.
          </Banner>
        </Stack>
      </Demo>
    </Section>
  )
}

export function DataSection(): ReactNode {
  const [sel, setSel] = useState('b')
  const [on, setOn] = useState(true)
  return (
    <Section id="data" title="Card · List · Accordion · Avatar">
      <Demo label="Card">
        <Stack>
          <Card icon={<Brain />} title="Voyage AI memory" description="voyage-4-lite · 1024 dims" actions={<Switch aria-label="Memory on" checked={on} onChange={setOn} />}>
            12,408 messages indexed · keyword search works without it.
          </Card>
          <Row>
            {(['a', 'b'] as const).map((v) => (
              <Card key={v} onClick={() => setSel(v)} selected={sel === v} icon={v === 'a' ? <Laptop /> : <Cpu />} title={v === 'a' ? 'Windows voices' : 'ElevenLabs'} description={v === 'a' ? 'Offline · free' : 'Natural · uses credits'} padding="sm" />
            ))}
          </Row>
          <Card tone="accent" title="Continued in #M2R8QA" description="This chat continues in a new session." footer={<Button size="sm">Open →</Button>} />
        </Stack>
      </Demo>
      <Demo label="List">
        <List aria-label="Devices" inset dividers>
          <ListItem icon={<Laptop />} title="This PC" description="Desktop app · now" meta={<Badge tone="success" dot>Online</Badge>} />
          <ListItem
            icon={<Smartphone />}
            title="Pixel 9"
            description="Local network · 2 min ago"
            actions={
              <Button size="sm" variant="ghost" onClick={() => toast.info('Revoked')}>
                Revoke
              </Button>
            }
          />
          <ListItem icon={<Smartphone />} title="iPhone" description="Tailscale · 3 days ago" onClick={() => toast.info('Details')} actions={<IconButton size="sm" label="Remove iPhone" icon={<Trash2 />} />} />
          <ListItem icon={<Avatar kind="user" name="Skye Hosting" size={32} />} title="Skye" description="Selected row" selected onClick={() => undefined} />
        </List>
      </Demo>
      <Demo label="Accordion · Disclosure">
        <Accordion
          items={[
            { value: 'sent', title: 'What leaves this PC?', content: <p>Your messages go to the AI service you chose; memory and voice services receive text when enabled.</p> },
            { value: 'stored', title: 'Where is it stored?', meta: '%APPDATA%\\Vesper', content: <p>Chats, settings and keys stay in your Windows profile.</p> },
            { value: 'delete', title: 'How do I delete everything?', content: <p>Settings → Data → Delete all data.</p> }
          ]}
        />
        <Disclosure summary="Advanced" variant="card" meta="3 settings">
          <p>Hidden until opened.</p>
        </Disclosure>
      </Demo>
      <Demo label="Avatar">
        <Row>
          <Avatar kind="ai" size={20} />
          <Avatar kind="ai" />
          <Avatar kind="ai" size={36} state="thinking" label="Vesper is thinking" />
          <Avatar kind="ai" size={44} state="speaking" label="Vesper is speaking" />
          <Avatar kind="ai" size={44} state="listening" label="Vesper is listening" />
          <Avatar kind="user" name="Skye Hosting" />
          <Avatar kind="user" name="élodie" size={36} />
          <Avatar kind="user" size={44} label="Unknown user" />
        </Row>
      </Demo>
    </Section>
  )
}

export function MemorySection(): ReactNode {
  const [items, setItems] = useState(RECALLED)
  const [lazy, setLazy] = useState<typeof RECALLED | undefined>(undefined)
  return (
    <Section id="remembered" title="Remembered chip" description="07 A4: under an AI reply that used recalled memories — expands to the rounds with Jump to / Forget.">
      <Demo label="With items" wide>
        <RememberedChip
          count={items.length}
          items={items}
          nowUtc={NOW}
          userName="Skye"
          defaultOpen
          onJump={(r) => toast.info(`Jump to ${r.sessionTitle}`)}
          onForget={(r) => setItems(items.filter((x) => x.id !== r.id))}
        />
      </Demo>
      <Demo label="Loads on expand">
        <RememberedChip count={2} items={lazy} nowUtc={NOW} onExpand={() => window.setTimeout(() => setLazy(RECALLED.slice(0, 2)), 900)} />
      </Demo>
    </Section>
  )
}

export function CodeSection(): ReactNode {
  const [streaming, setStreaming] = useState(true)
  return (
    <Section id="code" title="CodeBlock · CopyButton" description="Highlighted in a Web Worker (shiki, lazy grammars, LRU 500); open fences stay plain while streaming.">
      <Demo label="TypeScript" wide testId="gallery-code-ts">
        <CodeBlock code={TS_SAMPLE} lang="ts" title="debounce.ts" />
      </Demo>
      <Demo label="Python · line numbers">
        <CodeBlock code={PY_SAMPLE} lang="python" lineNumbers />
      </Demo>
      <Demo label="Streaming (plain) · unknown language">
        <Stack>
          <CodeBlock code={'const reply = await vesper.answer(\n  "how far is'} lang="js" streaming={streaming} />
          <Button size="sm" onClick={() => setStreaming(!streaming)}>
            {streaming ? 'Close the fence' : 'Stream again'}
          </Button>
          <CodeBlock code={'model Session {\n  id    Int    @id\n  title String\n}\n'} lang="prisma" />
        </Stack>
      </Demo>
      <Demo label="CopyButton">
        <Row>
          <CopyButton text="Hello from Vesper" />
          <CopyButton text="# Markdown" label="Copy as Markdown" variant="button" />
          <CopyButton getText={() => 'Plain text'} label="Copy as plain text" variant="button" size="md" />
        </Row>
      </Demo>
    </Section>
  )
}

export function QrSection(): ReactNode {
  return (
    <Section id="qr" title="QR code" description="Loaded on demand; always dark on white so phone cameras read it in either theme.">
      <Demo label="Pairing">
        <Row>
          <QRCode value="https://vesper.example.ts.net/pair#code=7Q2M-XK4P" label="Pairing code: scan with your phone to pair" size={196} />
          <Stack gap={8}>
            <p className="g-note">Scan with your phone's camera, or enter the code:</p>
            <p className="mono g-code">7Q2M-XK4P</p>
            <Row>
              <CopyButton text="7Q2M-XK4P" label="Copy code" variant="button" />
              <Button size="sm" variant="ghost" icon={<Download />}>
                Save image
              </Button>
            </Row>
            <Row>
              <Badge tone="warning" dot>
                Expires in 4:58
              </Badge>
              <Button size="sm" variant="ghost" icon={<BookOpen />}>
                Help
              </Button>
            </Row>
          </Stack>
        </Row>
      </Demo>
    </Section>
  )
}
