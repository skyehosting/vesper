/**
 * Voice out building blocks (R12, R13, 07 A2/C22): provider, key → voices filled automatically, model with price and
 * speed badges, "Play sample", voice tones (mode + placement), playback. Used by Settings → Voice out and the wizard's step 4.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AudioLines, Cloud, MonitorSpeaker, Play, RefreshCw, Server, Sparkles, Square } from 'lucide-react'
import { ttsDisclosure } from '@shared/privacy'
import { baseUrlProblem, settingsSchema, type Settings } from '@shared/settings'
import { TONE_MODE_OPTIONS, toneSupport, type ToneMode } from '@shared/voiceTone'
import { Badge, LeavesPcBadge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Combobox } from '../../../components/Combobox'
import { IconButton } from '../../../components/IconButton'
import { cx } from '../../../components/internal/cx'
import { ProgressBar } from '../../../components/Progress'
import { RadioGroup, type RadioOption } from '../../../components/RadioGroup'
import { SecretInput } from '../../../components/SecretInput'
import { Select, type SelectOption } from '../../../components/Select'
import { Slider } from '../../../components/Slider'
import { Switch } from '../../../components/Switch'
import { TextField } from '../../../components/TextField'
import { useStore } from '../../../lib/store'
import { setAutoSpeak } from '../speechClient'
import { useVoicePrefs } from '../prefs'
import { effectiveAutoSpeak } from '../prefs.logic'
import { keyLooksWrong, modelBadges, providerMeta, quotaShare, quotaText, sortVoices, TTS_PROVIDER_META, voiceDetail, type UiTtsProvider } from '../voices.logic'
import { fetchAudio, removeSecret, saveSecret, useAudioPlayer, useCanEdit, useSecretSaved, useSettingsPatch, useVoices } from './hooks'
import { controlId } from './ids.logic'
import { LabeledSegmented, PrivacyNote } from './parts'

type Tts = Settings['voice']['tts']
const DEFAULT_TTS: Tts = settingsSchema.parse({}).voice.tts

export function useTts(): Tts {
  return useStore((s) => s.settings?.voice.tts ?? DEFAULT_TTS)
}

const ICONS: Record<UiTtsProvider, ReactNode> = {
  elevenlabs: <Sparkles />,
  openai: <AudioLines />,
  windows: <MonitorSpeaker />,
  'openai-compatible': <Server />
}

/** Slider that shows changes live and saves once per gesture. */
function SettingSlider(p: { id: string; label: string; hint?: ReactNode; value: number; min: number; max: number; step: number; format: (v: number) => string; disabled?: boolean; onSave: (v: number) => void }): ReactNode {
  const [v, setV] = useState(p.value)
  useEffect(() => setV(p.value), [p.value])
  return <Slider id={p.id} label={p.label} hint={p.hint} value={v} min={p.min} max={p.max} step={p.step} format={p.format} bubble="never" disabled={p.disabled} onChange={setV} onCommit={p.onSave} />
}

// ── provider ──────────────────────────────────────────────────────────────────────────────────

export function ProviderPicker({ compact }: { compact?: boolean }): ReactNode {
  const tts = useTts()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const options: RadioOption<UiTtsProvider>[] = TTS_PROVIDER_META.map((m) => ({
    value: m.id,
    label: m.label,
    description: compact ? undefined : m.description,
    icon: ICONS[m.id],
    badge: m.cloud ? <LeavesPcBadge service={m.label} what="reply text" /> : <Badge tone="success">On this PC</Badge>
  }))
  return (
    <div id={controlId('voice.tts.provider')}>
      <RadioGroup<UiTtsProvider>
        label="Voice service"
        variant="cards"
        columns={2}
        value={(tts.provider === 'piper' ? 'windows' : tts.provider) as UiTtsProvider}
        disabled={!canEdit('voice.tts.provider')}
        onChange={(provider) => {
          if (provider === tts.provider) return
          // Voices and models belong to one provider: choose again (the first premade voice is picked for you).
          switchingTo = provider
          void patch({ voice: { tts: { provider, voiceId: null, model: null } } }).finally(() => {
            if (switchingTo === provider) switchingTo = null
          })
        }}
        options={options}
      />
    </div>
  )
}

/**
 * The provider this page asked the server to switch to and is waiting on (the picker shows the server's answer, not an
 * optimistic one). Until then the voice auto-pick must not save a voice of the provider being left.
 */
let switchingTo: string | null = null

// ── key, voices, model, sample ────────────────────────────────────────────────────────────────

export function VoiceSetup({ wizard }: { wizard?: boolean }): ReactNode {
  const tts = useTts()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const assistant = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const meta = providerMeta(tts.provider)
  const keySaved = useSecretSaved(meta.secret)
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const urlOk = !meta.needsUrl || (!!tts.baseUrl && baseUrlProblem(tts.baseUrl) === null)
  const ready = urlOk && (meta.secret === null || keySaved || meta.id === 'openai-compatible')
  const v = useVoices(tts.provider, ready)
  const player = useAudioPlayer()

  const voices = useMemo(() => sortVoices(v.voices), [v.voices])
  // 07 C22: once voices are known and none is chosen, take the first premade one (the server does the same on a key
  // save; this covers providers without a key, like Windows).
  const autoPicked = useRef<string | null>(null)
  useEffect(() => {
    if (tts.voiceId || !voices.length || !canEdit('voice.tts.voiceId') || autoPicked.current === tts.provider) return
    // Not while this page is switching away from that provider: the pick would land after the switch (old voice saved).
    if (switchingTo !== null && switchingTo !== tts.provider) return
    autoPicked.current = tts.provider
    void patch({ voice: { tts: { voiceId: voices[0].id } } })
  }, [voices, tts.voiceId, tts.provider, patch, canEdit])

  const voiceOptions: SelectOption[] = voices.map((x) => ({ value: x.id, label: x.name, description: voiceDetail(x) || undefined, keywords: [x.language ?? '', x.gender ?? '', x.category ?? ''] }))
  const selected = voices.find((x) => x.id === tts.voiceId) ?? null
  const cheapest = Math.min(...v.models.map((m) => m.costMultiplier ?? Infinity))
  const modelOptions: SelectOption[] = [
    { value: '', label: 'Automatic', description: meta.id === 'elevenlabs' ? 'The lowest-priced model that speaks with tone' : 'The provider’s default' },
    ...v.models.map((m) => ({
      value: m.id,
      label: m.label ?? m.id,
      description: m.label && m.label !== m.id ? m.id : undefined,
      meta: (
        <span className="vs-badges">
          {modelBadges(m, cheapest).map((b) => (
            <Badge key={b.text} tone={b.tone}>
              {b.text}
            </Badge>
          ))}
        </span>
      )
    }))
  ]

  const sampleText = `Hi, I'm ${assistant}. This is how I'll sound when I answer you.`
  const playSample = (): void =>
    void player.play('sample', (signal) => fetchAudio('/api/tts/sample', { method: 'POST', body: { provider: tts.provider, voiceId: tts.voiceId ?? undefined, text: sampleText }, signal }))
  const playPreview = (voiceId: string): void =>
    void player.play(`preview:${voiceId}`, (signal) => fetchAudio(`/api/tts/preview/${encodeURIComponent(tts.provider)}/${encodeURIComponent(voiceId)}`, { signal }))

  const keyHint =
    meta.id === 'elevenlabs'
      ? 'Create one at elevenlabs.io → Profile → API keys. Give it the “Text to speech” and “Voices: read” permissions.'
      : meta.id === 'openai'
        ? 'Create one at platform.openai.com → API keys.'
        : 'Only if your server asks for one.'

  const quota = quotaText(v.quota)
  const share = quotaShare(v.quota)

  return (
    <div className="vs-stack">
      {meta.needsUrl ? <BaseUrlField /> : null}
      {meta.secret ? (
        desktop ? (
          <SecretInput
            id="vs-tts-key"
            label={`${meta.label} key`}
            saved={keySaved}
            placeholder={meta.keyPlaceholder}
            hint={keyHint}
            validate={(x) => (meta.id === 'openai-compatible' ? null : keyLooksWrong(meta.id, x))}
            onSave={async (value) => {
              v.expectBroadcast()
              await saveSecret(meta.secret as string, value)
            }}
            onRemove={() => removeSecret(meta.secret as string)}
          />
        ) : keySaved ? null : (
          <p className="vs-note">Add the {meta.label} key in Vesper on your PC.</p>
        )
      ) : null}

      <div className="vs-row">
        <Combobox
          id={controlId('voice.tts.voiceId')}
          wrapClassName="vs-row__grow"
          label="Voice"
          value={tts.voiceId}
          onChange={(voiceId) => voiceId && void patch({ voice: { tts: { voiceId } } })}
          options={voiceOptions}
          loading={v.loading || v.awaiting}
          disabled={!ready || !canEdit('voice.tts.voiceId')}
          placeholder={!ready ? (meta.needsUrl && !urlOk ? 'Enter the server address first' : 'Save your key to load the voices') : v.loading || v.awaiting ? 'Loading voices…' : voices.length ? 'Search voices' : 'No voices'}
          emptyText={v.loading || v.awaiting ? 'Loading voices…' : 'No voices match'}
          error={v.error ?? undefined}
          hint={!v.error && ready && voices.length ? `${voices.length} voice${voices.length === 1 ? '' : 's'} available.` : undefined}
        />
        <div className="vs-row__actions">
          {selected?.previewable ? (
            <IconButton
              label={player.playing === `preview:${selected.id}` ? 'Stop preview' : `Preview ${selected.name}`}
              icon={player.playing === `preview:${selected.id}` ? <Square /> : <Play />}
              variant="secondary"
              loading={player.loading === `preview:${selected.id}`}
              onClick={() => (player.playing === `preview:${selected.id}` ? player.stop() : playPreview(selected.id))}
            />
          ) : null}
          {ready ? <IconButton label="Refresh the voice list" icon={<RefreshCw />} variant="ghost" loading={v.loading} onClick={() => v.refresh()} /> : null}
        </div>
      </div>

      {v.models.length > 1 && !wizard ? (
        <Select
          id={controlId('voice.tts.model')}
          label="Model"
          value={tts.model ?? ''}
          onChange={(m) => void patch({ voice: { tts: { model: m || null } } })}
          options={modelOptions}
          disabled={!canEdit('voice.tts.model')}
          hint={meta.id === 'elevenlabs' ? 'Prices are relative to ElevenLabs’ base price per character.' : undefined}
        />
      ) : null}

      {quota && share !== null ? <ProgressBar label="Characters left this month" value={share} valueText={quota} tone={share < 0.1 ? 'danger' : share < 0.25 ? 'warning' : 'success'} size="sm" /> : null}

      <div className="vs-sample">
        <Button
          icon={player.playing === 'sample' ? <Square /> : <Play />}
          loading={player.loading === 'sample'}
          disabled={!ready || (!tts.voiceId && meta.id !== 'windows')}
          onClick={() => (player.playing === 'sample' ? player.stop() : playSample())}
          data-testid="vs-play-sample"
        >
          {player.playing === 'sample' ? 'Stop' : 'Play sample'}
        </Button>
        <span className="vs-sample__hint">{meta.cloud ? 'Uses a few characters of your quota.' : 'Generated on this PC.'}</span>
      </div>
    </div>
  )
}

function BaseUrlField(): ReactNode {
  const tts = useTts()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const [url, setUrl] = useState(tts.baseUrl)
  useEffect(() => setUrl(tts.baseUrl), [tts.baseUrl])
  const problem = url.trim() ? baseUrlProblem(url.trim()) : null
  const save = (): void => {
    const next = url.trim()
    if (next === tts.baseUrl || (next && baseUrlProblem(next))) return
    void patch({ voice: { tts: { baseUrl: next } } })
  }
  return (
    <TextField
      id={controlId('voice.tts.baseUrl')}
      label="Server address"
      placeholder="https://my-server.example/v1"
      value={url}
      leading={<Cloud />}
      error={problem ?? undefined}
      hint="The address of an OpenAI-compatible speech server (it must answer /audio/speech)."
      disabled={!canEdit('voice.tts.baseUrl')}
      onChange={(e) => setUrl(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
      }}
    />
  )
}

export function ProviderPrivacy({ compact }: { compact?: boolean }): ReactNode {
  const tts = useTts()
  // By provider AND address: an OpenAI-compatible server on this PC is local, elsewhere unknown — never OpenAI (F20).
  return <PrivacyNote disclosure={ttsDisclosure(tts.provider, tts.baseUrl)} compact={compact} />
}

// ── tone (R13, 07 A2, H-v11-tone) ─────────────────────────────────────────────────────────────

/**
 * "Voice tones": Off · Follow the conversation · Every reply, with the chosen mode's sentence; whether the voice in use
 * can use a tone at all; and, under it, where the AI puts the tag. Shown next to the voice choice (Settings and the
 * wizard), so it is found where the voice is chosen.
 */
export function ToneSettings({ wizard }: { wizard?: boolean }): ReactNode {
  const tts = useTts()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const support = toneSupport(tts.provider, tts.model)
  const chosen = TONE_MODE_OPTIONS.find((o) => o.value === tts.toneMode) ?? TONE_MODE_OPTIONS[1]
  const on = tts.toneMode !== 'off' && support.ok
  return (
    <div className="vs-stack vs-tone" data-testid="vs-tone">
      <LabeledSegmented<ToneMode>
        id={controlId('voice.tts.toneMode')}
        label="Voice tones"
        value={tts.toneMode}
        disabled={!canEdit('voice.tts.toneMode')}
        onChange={(toneMode) => void patch({ voice: { tts: { toneMode } } })}
        options={TONE_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        hint={chosen.text}
      />
      {tts.toneMode !== 'off' ? (
        <p className={cx('vs-note', 'vs-tone__support', !support.ok && 'is-unsupported')} data-testid="vs-tone-support" data-supported={support.ok ? 'true' : 'false'}>
          {support.text}
          {support.ok ? ' The tag is never shown in the chat or stored in memory.' : null}
        </p>
      ) : null}
      <LabeledSegmented<'start' | 'end'>
        id={controlId('voice.tts.tonePlacement')}
        label="Where the AI puts the tone"
        value={tts.tonePlacement}
        disabled={!canEdit('voice.tts.tonePlacement') || !on}
        onChange={(tonePlacement) => void patch({ voice: { tts: { tonePlacement } } })}
        options={[
          { value: 'start', label: 'At the start (recommended)' },
          { value: 'end', label: 'At the end' }
        ]}
        hint={
          tts.tonePlacement === 'start'
            ? 'The voice can’t start in the right tone if the tone arrives at the end — so by default the AI states it first.'
            : 'Short replies wait for the tone at the end. Longer ones start speaking in the previous tone and switch where the tone appears.'
        }
      />
      {!wizard ? (
        <Switch
          id={controlId('voice.tts.waitForTone')}
          label="Always wait for the tone"
          description="Hold the voice until the whole reply is written. The tone is always right, but speaking starts later."
          checked={tts.waitForTone}
          disabled={!canEdit('voice.tts.waitForTone') || !on}
          onChange={(waitForTone) => void patch({ voice: { tts: { waitForTone } } })}
        />
      ) : null}
    </div>
  )
}

// ── playback ──────────────────────────────────────────────────────────────────────────────────

export function PlaybackSettings(): ReactNode {
  const tts = useTts()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const prefs = useVoicePrefs()
  const deviceSpeak = effectiveAutoSpeak(prefs, tts.autoSpeak)
  return (
    <div className="vs-stack">
      <Switch
        id="vs-device-autospeak"
        label="Speak replies on this device"
        description="The speaker button in the top bar does the same. Other devices keep their own choice."
        checked={deviceSpeak}
        onChange={(on) => setAutoSpeak(on)}
      />
      <LabeledSegmented<'synced' | 'text-first'>
        id={controlId('voice.tts.reveal')}
        label="Text and voice"
        value={tts.reveal}
        disabled={!canEdit('voice.tts.reveal')}
        onChange={(reveal) => void patch({ voice: { tts: { reveal } } })}
        options={[
          { value: 'synced', label: 'Text appears with the voice' },
          { value: 'text-first', label: 'Text first' }
        ]}
        hint={tts.reveal === 'synced' ? 'Each reply waits for its voice, then fades in letter by letter as it is spoken.' : 'Replies appear as they are written; the voice follows.'}
      />
      <div className="vs-grid2">
        <SettingSlider
          id={controlId('voice.tts.speed')}
          label="Speed"
          value={tts.speed}
          min={0.7}
          max={1.3}
          step={0.05}
          format={(x) => `${x.toFixed(2)}×`}
          disabled={!canEdit('voice.tts.speed')}
          onSave={(speed) => void patch({ voice: { tts: { speed } } })}
        />
        <SettingSlider
          id={controlId('voice.tts.volume')}
          label="Volume"
          value={tts.volume}
          min={0}
          max={1}
          step={0.05}
          format={(x) => `${Math.round(x * 100)}%`}
          disabled={!canEdit('voice.tts.volume')}
          onSave={(volume) => void patch({ voice: { tts: { volume } } })}
        />
      </div>
      <LabeledSegmented<'sender' | 'all'>
        id={controlId('voice.tts.perDevice')}
        label="Which device speaks"
        value={tts.perDevice}
        disabled={!canEdit('voice.tts.perDevice')}
        onChange={(perDevice) => void patch({ voice: { tts: { perDevice } } })}
        options={[
          { value: 'sender', label: 'The one I typed on' },
          { value: 'all', label: 'Every open device' }
        ]}
        hint={tts.perDevice === 'sender' ? 'Only the device that sent the message plays the reply.' : 'Every device showing the chat with sound on plays it.'}
      />
      <Switch
        id={controlId('voice.tts.fastModelInTalk')}
        label="Fast voice in Talk mode"
        description={tts.provider === 'elevenlabs' ? 'Talk mode uses ElevenLabs’ quickest model so replies start sooner.' : 'Available with ElevenLabs.'}
        checked={tts.fastModelInTalk}
        disabled={!canEdit('voice.tts.fastModelInTalk') || tts.provider !== 'elevenlabs'}
        onChange={(fastModelInTalk) => void patch({ voice: { tts: { fastModelInTalk } } })}
      />
    </div>
  )
}

export function AdvancedVoiceOut(): ReactNode {
  const tts = useTts()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const eleven = tts.provider === 'elevenlabs'
  return (
    <div className="vs-stack">
      <LabeledSegmented<'skip' | 'announce'>
        id={controlId('voice.tts.speakCode')}
        label="Code blocks"
        value={tts.speakCode}
        disabled={!canEdit('voice.tts.speakCode')}
        onChange={(speakCode) => void patch({ voice: { tts: { speakCode } } })}
        options={[
          { value: 'skip', label: 'Skip silently' },
          { value: 'announce', label: 'Say “code block”' }
        ]}
      />
      <div className="vs-grid2">
        <SettingSlider
          id={controlId('voice.tts.stability')}
          label="Stability"
          hint={eleven ? 'Lower is more expressive, higher is steadier.' : 'ElevenLabs only.'}
          value={tts.stability}
          min={0}
          max={1}
          step={0.05}
          format={(x) => x.toFixed(2)}
          disabled={!eleven || !canEdit('voice.tts.stability')}
          onSave={(stability) => void patch({ voice: { tts: { stability } } })}
        />
        <SettingSlider
          id={controlId('voice.tts.similarity')}
          label="Similarity"
          hint={eleven ? 'How closely to stick to the original voice.' : 'ElevenLabs only.'}
          value={tts.similarity}
          min={0}
          max={1}
          step={0.05}
          format={(x) => x.toFixed(2)}
          disabled={!eleven || !canEdit('voice.tts.similarity')}
          onSave={(similarity) => void patch({ voice: { tts: { similarity } } })}
        />
      </div>
      <Switch
        id={controlId('voice.tts.autoSpeak')}
        label="Speak replies on new devices"
        description="The starting point for devices that haven’t chosen for themselves."
        checked={tts.autoSpeak}
        disabled={!canEdit('voice.tts.autoSpeak')}
        onChange={(autoSpeak) => void patch({ voice: { tts: { autoSpeak } } })}
      />
      <SettingSlider
        id={controlId('voice.tts.localUnloadAfterMin')}
        label="Unload a local voice after"
        hint="Frees memory when a voice that runs on this PC hasn’t spoken for a while."
        value={tts.localUnloadAfterMin}
        min={0}
        max={120}
        step={1}
        format={(x) => (x === 0 ? 'Right away' : `${x} min`)}
        disabled={!canEdit('voice.tts.localUnloadAfterMin')}
        onSave={(localUnloadAfterMin) => void patch({ voice: { tts: { localUnloadAfterMin } } })}
      />
    </div>
  )
}
