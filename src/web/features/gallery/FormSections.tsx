/** Gallery: inputs, selection controls, slider, secret input, file intake. */
import { useState, type ReactNode } from 'react'
import { AtSign, Globe, Laptop, Monitor, Moon, Network, Rocket, Route, Search, Sun, Wifi } from 'lucide-react'
import { Badge, Chip, LeavesPcBadge } from '../../components/Badge'
import { Checkbox } from '../../components/Checkbox'
import { Combobox } from '../../components/Combobox'
import { DropOverlay, FileDrop, useFileDrop } from '../../components/FileDrop'
import { RadioGroup } from '../../components/RadioGroup'
import { SecretInput } from '../../components/SecretInput'
import { Segmented } from '../../components/Segmented'
import { Select } from '../../components/Select'
import { Slider } from '../../components/Slider'
import { Switch } from '../../components/Switch'
import { TextArea } from '../../components/TextArea'
import { TextField } from '../../components/TextField'
import { formatBytes } from '../../components/internal/files.logic'
import { formatSeconds } from '../../components/internal/slider.logic'
import { ApiErrorException } from '../../lib/errors.logic'
import { apiError } from '@shared/errors'
import { Demo, Row, Section, Stack } from './Section'
import { MODELS, VOICES } from './sample'

const ACCENT_OPTIONS = [
  { value: 'gold', label: 'Vesper gold', description: 'Warm white-gold core' },
  { value: 'violet', label: 'Dusk violet', description: 'Lilac core, indigo corona' },
  { value: 'rose', label: 'Rose', description: 'Pink core, plum corona' },
  { value: 'aurora', label: 'Aurora', description: 'Mint core, teal corona' },
  { value: 'ice', label: 'Ice', description: 'Blue-white core, cyan corona' }
]

export function InputsSection(): ReactNode {
  const [name, setName] = useState('Skye')
  const [url, setUrl] = useState('http://example.com/v1')
  const [prompt, setPrompt] = useState('You are Vesper, a calm companion. Keep answers short unless asked.')
  return (
    <Section id="inputs" title="Text fields" description="Label, hint and error are wired to the control (aria-describedby / aria-invalid).">
      <Demo label="TextField">
        <Stack>
          <TextField label="Your name" value={name} onChange={(e) => setName(e.target.value)} hint="Vesper uses it in greetings." data-testid="g-name" />
          <TextField
            label="Base URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            leading={<Globe />}
            error={url.startsWith('http://') ? 'Use https:// unless the service runs on this PC.' : undefined}
            required
          />
          <TextField label="Port" type="number" defaultValue={41730} trailing={<span className="g-unit">TCP</span>} size="sm" />
          <TextField aria-label="Search chats" placeholder="Search chats" leading={<Search />} type="search" />
          <TextField label="Disabled" value="Read only on phones" disabled onChange={() => undefined} />
        </Stack>
      </Demo>
      <Demo label="TextArea (auto-grow)">
        <Stack>
          <TextArea label="System prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} minRows={2} maxRows={8} maxLength={2000} showCount data-testid="g-prompt" />
          <TextArea label="Notes" mono placeholder="Monospace, uncontrolled" minRows={2} />
          <TextArea label="Has an error" defaultValue="{ bad json" error="That isn't valid JSON." minRows={1} />
        </Stack>
      </Demo>
    </Section>
  )
}

export function SelectSection(): ReactNode {
  const [accent, setAccent] = useState<string | null>('gold')
  const [model, setModel] = useState<string | null>(null)
  const [voice, setVoice] = useState<string | null>('rachel')
  const [voice2, setVoice2] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [remote, setRemote] = useState(VOICES.slice(0, 0))
  return (
    <Section id="select" title="Select · Combobox" description="Keyboard: ↑ ↓ Home End PageUp PageDown, type to jump, Enter/Space choose, Esc close.">
      <Demo label="Select">
        <Stack>
          <Select label="Accent" value={accent} onChange={setAccent} options={ACCENT_OPTIONS} id="g-accent-select" />
          <Select label="Model" value={model} onChange={setModel} options={MODELS} placeholder="Choose a model" labelExtra={<LeavesPcBadge service="the AI provider" />} />
          <Select aria-label="Size" size="sm" value="m" onChange={() => undefined} options={[{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'Large' }]} />
          <Select label="Disabled" value="a" onChange={() => undefined} options={[{ value: 'a', label: 'Not now' }]} disabled />
        </Stack>
      </Demo>
      <Demo label="Combobox (searchable)">
        <Stack>
          <Combobox label="Voice" value={voice} onChange={setVoice} options={VOICES} hint="Type to filter by name or accent." id="g-voice" clearable />
          <Combobox
            label="Voice (server search)"
            value={voice2}
            onChange={setVoice2}
            options={remote}
            loading={loading}
            placeholder="Search the voice library"
            emptyText={loading ? 'Searching…' : 'No voices found'}
            onQueryChange={(q) => {
              setLoading(true)
              window.setTimeout(() => {
                setRemote(VOICES.filter((v) => v.label.toLowerCase().includes(q.toLowerCase())))
                setLoading(false)
              }, 300)
            }}
          />
          <Combobox label="Error state" value={null} onChange={() => undefined} options={MODELS} error="Pick a model first." size="sm" />
        </Stack>
      </Demo>
    </Section>
  )
}

export function TogglesSection(): ReactNode {
  const [speak, setSpeak] = useState(true)
  const [game, setGame] = useState(false)
  const [both, setBoth] = useState(true)
  const [a, setA] = useState(true)
  const [b, setB] = useState(false)
  const [mode, setMode] = useState<string | null>('local')
  const [start, setStart] = useState<string | null>('quick')
  const [theme, setTheme] = useState('dark')
  const [style, setStyle] = useState('orb')
  return (
    <Section id="toggles" title="Switch · Checkbox · Radio · Segmented">
      <Demo label="Switch">
        <Stack>
          <Switch label="Speak replies" description="Uses your voice provider; text appears as the voice speaks." checked={speak} onChange={setSpeak} />
          <Switch label="Game mode" description="Pause the Star and background work while a game is fullscreen." checked={game} onChange={setGame} />
          <Switch label="Small, switch first" size="sm" switchPosition="start" checked={speak} onChange={setSpeak} />
          <Switch label="Disabled" checked disabled onChange={() => undefined} />
          <Row>
            <Switch aria-label="Bare switch" checked={game} onChange={setGame} />
          </Row>
        </Stack>
      </Demo>
      <Demo label="Checkbox">
        <Stack gap={4}>
          <Checkbox label="Link both ways" description="Each session can recall the other." checked={both} onChange={setBoth} />
          <Checkbox label="Select all (mixed)" checked={a && b} indeterminate={a !== b} onChange={(v) => (setA(v), setB(v))} />
          <div className="g-indent">
            <Checkbox label="Messages" checked={a} onChange={setA} />
            <Checkbox label="Attachments" checked={b} onChange={setB} />
          </div>
          <Checkbox label="Disabled" checked={false} disabled onChange={() => undefined} />
        </Stack>
      </Demo>
      <Demo label="RadioGroup">
        <RadioGroup
          label="Who can open Vesper"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'local', label: 'This PC', description: 'Nothing listens on the network.' },
            { value: 'lan', label: 'Local network', description: 'Phones on your Wi-Fi (HTTPS, password).' },
            { value: 'tailnet', label: 'Anywhere with Tailscale', description: 'Your devices, end-to-end encrypted.' },
            { value: 'funnel', label: 'Public link', description: 'Needs a strong password.', disabled: true }
          ]}
        />
      </Demo>
      <Demo label="Radio cards (wizard choices)" wide>
        <RadioGroup
          label="How do you want to set up?"
          variant="cards"
          columns={2}
          value={start}
          onChange={setStart}
          options={[
            { value: 'quick', label: 'Quick start', description: 'AI provider only — chatting in a minute.', icon: <Rocket />, badge: <Badge tone="accent">Recommended</Badge> },
            { value: 'guided', label: 'Guided', description: 'Memory, voice, access and looks, step by step.', icon: <Route /> }
          ]}
        />
        <RadioGroup
          label="Access"
          labelHidden
          variant="cards"
          columns={3}
          value={mode}
          onChange={setMode}
          options={[
            { value: 'local', label: 'This PC', description: 'Default', icon: <Laptop /> },
            { value: 'lan', label: 'LAN', description: 'Same Wi-Fi', icon: <Wifi /> },
            { value: 'tailnet', label: 'Tailscale', description: 'Anywhere', icon: <Network /> }
          ]}
        />
      </Demo>
      <Demo label="Segmented">
        <Stack>
          <Segmented
            aria-label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'dark', label: 'Dark', icon: <Moon /> },
              { value: 'light', label: 'Light', icon: <Sun /> },
              { value: 'system', label: 'System', icon: <Monitor /> }
            ]}
          />
          <Segmented
            aria-label="Star style"
            size="sm"
            value={style}
            onChange={setStyle}
            options={[
              { value: 'orb', label: 'Orb' },
              { value: 'nebula', label: 'Nebula' },
              { value: 'minimal2d', label: 'Minimal' },
              { value: 'off', label: 'Off' }
            ]}
          />
          <Segmented aria-label="Block" block value={style === 'off' ? 'b' : 'a'} onChange={(v) => setStyle(v === 'b' ? 'off' : 'orb')} options={[{ value: 'a', label: 'Full width A' }, { value: 'b', label: 'B' }]} />
        </Stack>
      </Demo>
    </Section>
  )
}

export function SliderSection(): ReactNode {
  const [silence, setSilence] = useState(1200)
  const [committed, setCommitted] = useState(1200)
  const [font, setFont] = useState(15)
  const [vol, setVol] = useState(0.7)
  return (
    <Section id="slider" title="Slider" description="Silence before sending: 300–5000 ms, default 1200 (07 C17). Arrows ±100 ms, PageUp/PageDown ±500 ms.">
      <Demo label="With value bubble and marks" testId="gallery-silence">
        <Slider
          label="Silence before sending"
          min={300}
          max={5000}
          step={100}
          value={silence}
          onChange={setSilence}
          onCommit={setCommitted}
          format={formatSeconds}
          marks={[
            { value: 300, label: '0.3 s' },
            { value: 1200, label: 'Default' },
            { value: 5000, label: '5 s' }
          ]}
          hint="How long Vesper waits after you stop talking."
        />
        <p className="g-note" data-testid="g-silence-committed">
          Saved: {committed} ms
        </p>
      </Demo>
      <Demo label="Bubble always · disabled">
        <Stack gap={24}>
          <Slider label="Message size" min={13} max={20} value={font} onChange={setFont} bubble="always" showValue={false} format={(v) => `${v} px`} />
          <Slider aria-label="Volume" min={0} max={1} step={0.05} value={vol} onChange={setVol} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Disabled" min={0} max={10} value={4} onChange={() => undefined} disabled />
        </Stack>
      </Demo>
    </Section>
  )
}

export function SecretSection(): ReactNode {
  const [saved, setSaved] = useState(true)
  const [saved2, setSaved2] = useState(false)
  return (
    <Section id="secret" title="SecretInput" description="Write-only: a saved key is never shown or prefilled. Paste trims whitespace; Enter saves. Type “bad” to see a refusal.">
      <Demo label="Saved">
        <SecretInput
          label="ElevenLabs API key"
          saved={saved}
          hint="Needs the “Voices: read” permission."
          onSave={() => new Promise<void>((r) => window.setTimeout(r, 400)).then(() => setSaved(true))}
          onRemove={() => setSaved(false)}
        />
      </Demo>
      <Demo label="Not saved yet">
        <SecretInput
          label="Voyage AI key"
          saved={saved2}
          validate={(v) => (v.length < 3 ? 'That looks too short for a key.' : null)}
          onSave={async (v) => {
            await new Promise((r) => window.setTimeout(r, 300))
            if (v === 'bad') throw new ApiErrorException(apiError('provider_auth'), 401)
            setSaved2(true)
          }}
          onRemove={() => setSaved2(false)}
        />
      </Demo>
    </Section>
  )
}

export function FilesSection(): ReactNode {
  const [files, setFiles] = useState<File[]>([])
  const add = (ok: File[]): void => setFiles((cur) => [...cur, ...ok].slice(-12))
  const { dragging, bind } = useFileDrop({ onFiles: add, maxFiles: 10, maxBytes: 25_000_000 })
  return (
    <Section id="files" title="FileDrop" description="Drop, paste (Ctrl+V while focused) or browse. Type, size and count are checked at once; the server checks again.">
      <Demo label="Drop zone">
        <FileDrop accept="image/*,.pdf,.docx,.txt,.md,.json,.csv" maxBytes={25_000_000} maxFiles={10} onFiles={add} />
      </Demo>
      <Demo label="Compact · whole-area target">
        <Stack>
          <FileDrop compact label="Attach a PDF" accept=".pdf" multiple={false} onFiles={add} />
          <div className="g-droparea" {...bind}>
            <AtSign aria-hidden="true" />
            <span>Drag files anywhere over this box</span>
            {dragging ? <DropOverlay /> : null}
          </div>
          <div className="g-row" aria-live="polite">
            {files.length === 0 ? <span className="g-note">No files yet.</span> : null}
            {files.map((f, i) => (
              <Chip key={`${f.name}-${i}`} onRemove={() => setFiles(files.filter((_, j) => j !== i))} removeLabel={`Remove ${f.name}`} title={f.name}>
                {f.name} · {formatBytes(f.size)}
              </Chip>
            ))}
          </div>
        </Stack>
      </Demo>
    </Section>
  )
}
