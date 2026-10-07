/**
 * Voice in building blocks (R19, R20; 07 C15, C17, D6, D8, B12): speech recognition on this PC (model download with
 * progress, SHA check, cancel, delete) or a cloud service (key + model), listening mode, the silence wait with a live
 * try-it area, microphone choice and processing, a mic test with a level meter, barge-in and the echo self-test.
 * Used by Settings → Voice in and the wizard's step 5.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, Cloud, Cpu, Download, Ear, Headphones, Mic, MicOff, RotateCcw, Trash2, TriangleAlert, X } from 'lucide-react'
import { defaultSettings, type Settings } from '@shared/settings'
import type { SttModelInfo } from '@shared/models'
import { Badge, LeavesPcBadge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { Callout } from '../../../components/Callout'
import { useConfirm } from '../../../components/ConfirmDialog'
import { IconButton } from '../../../components/IconButton'
import { ProgressBar } from '../../../components/Progress'
import { RadioGroup } from '../../../components/RadioGroup'
import { SecretInput } from '../../../components/SecretInput'
import { Select } from '../../../components/Select'
import { Slider } from '../../../components/Slider'
import { Switch } from '../../../components/Switch'
import { TextField } from '../../../components/TextField'
import { toast } from '../../../components/Toast'
import { formatBytes } from '../../../components/internal/files.logic'
import { formatSeconds } from '../../../components/internal/slider.logic'
import { createLevels, getAudioEngine, getMicCapture } from '../../../lib/audio'
import { api } from '../../../lib/api'
import { toApiError } from '../../../lib/errors.logic'
import { useStore } from '../../../lib/store'
import { MicControl } from '../MicControl'
import { micHelp } from '../mic.logic'
import { micActive, micPlaceOf, micPreflight } from '../micSession'
import { getVoicePrefs, setVoicePrefs, useVoicePrefs } from '../prefs'
import { unlockAudio } from '../speechClient'
import { chirpWav, cloudStt, echoVerdict, effectiveCloudModel, isBusy, modelProgressShare, modelProgressText, STT_CLOUD, STT_LANGUAGES, type CloudSttId, type EchoVerdict } from '../voicein.logic'
import { removeSecret, saveSecret, useCanEdit, useSecretSaved, useSettingsPatch, useSttModels } from './hooks'
import { controlId } from './ids.logic'
import { LabeledSegmented, PrivacyNote } from './parts'

type Stt = Settings['voice']['stt']
const DEFAULT_STT: Stt = defaultSettings().voice.stt

export function useStt(): Stt {
  return useStore((s) => s.settings?.voice.stt ?? DEFAULT_STT)
}

function SettingSlider(p: { id: string; label: string; hint?: ReactNode; value: number; min: number; max: number; step: number; format: (v: number) => string; disabled?: boolean; onSave: (v: number) => void; onLive?: (v: number) => void }): ReactNode {
  const [v, setV] = useState(p.value)
  useEffect(() => setV(p.value), [p.value])
  return (
    <Slider
      id={p.id}
      label={p.label}
      hint={p.hint}
      value={v}
      min={p.min}
      max={p.max}
      step={p.step}
      format={p.format}
      bubble="never"
      disabled={p.disabled}
      onChange={(x) => {
        setV(x)
        p.onLive?.(x)
      }}
      onCommit={p.onSave}
    />
  )
}

// ── engine: local or cloud ────────────────────────────────────────────────────────────────────

export function EngineSettings({ wizard }: { wizard?: boolean }): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const local = stt.provider === 'local'
  return (
    <div className="vs-stack">
      {!wizard ? (
        <div id={controlId('voice.stt.provider')}>
          <RadioGroup<'local' | 'cloud'>
            label="Where speech is recognized"
            labelHidden
            variant="cards"
            columns={2}
            value={local ? 'local' : 'cloud'}
            disabled={!canEdit('voice.stt.provider')}
            onChange={(v) => {
              if (v === 'local' && !local) void patch({ voice: { stt: { provider: 'local', model: DEFAULT_STT.model } } })
              if (v === 'cloud' && local) void patch({ voice: { stt: { provider: 'openai', model: 'gpt-4o-mini-transcribe' } } })
            }}
            options={[
              { value: 'local', label: 'On this PC', description: 'Private and free. Needs a one-time model download.', icon: <Cpu />, badge: <Badge tone="success">Recommended</Badge> },
              { value: 'cloud', label: 'Cloud service', description: 'Your own key; audio of each utterance is uploaded.', icon: <Cloud />, badge: <LeavesPcBadge service="the speech service" what="voice audio" /> }
            ]}
          />
        </div>
      ) : null}
      {local ? <LocalEngine wizard={wizard} /> : <CloudEngine />}
    </div>
  )
}

function LocalEngine({ wizard }: { wizard?: boolean }): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  return (
    <>
      <PrivacyNote id="local-stt" compact={wizard} />
      <ModelList wizard={wizard} />
      {!wizard ? (
        <Select
          id={controlId('voice.stt.language')}
          label="Language"
          value={stt.language}
          options={STT_LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
          disabled={!canEdit('voice.stt.language')}
          hint="Parakeet detects 25 European languages by itself; pick one if it guesses wrong."
          onChange={(language) => void patch({ voice: { stt: { language } } })}
        />
      ) : null}
    </>
  )
}

export function ModelList({ wizard }: { wizard?: boolean }): ReactNode {
  const stt = useStt()
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const m = useSttModels()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const { confirm, dialog } = useConfirm()
  const list = wizard ? m.models.filter((x) => x.recommended || x.active || x.state !== 'not-installed').slice(0, 3) : m.models
  // P23 (setup wizard): once the model in use becomes ready on this step (downloaded, or "Use this model"), voice input
  // is turned on — what Continue would save anyway — so the switch, the "In use" badge and the try-out below agree. A
  // model that was already ready when the step opened changes nothing (the owner may have turned voice input off).
  const activeReady = !m.loading && m.models.some((x) => x.id === stt.model && x.state === 'installed')
  const wasReady = useRef<boolean | null>(null)
  useEffect(() => {
    if (m.loading) return
    const was = wasReady.current
    wasReady.current = activeReady
    if (wizard && was === false && activeReady && !stt.enabled) void patch({ voice: { stt: { enabled: true } } })
  }, [wizard, activeReady, m.loading, stt.enabled, patch])
  if (m.loading && !m.models.length) return <ProgressBar aria-label="Loading speech models" size="sm" />
  if (m.error && !m.models.length)
    return (
      <Callout tone="danger" title="Couldn't list the speech models" actions={<Button size="sm" icon={<RotateCcw />} onClick={m.reload}>Try again</Button>}>
        {m.error}
      </Callout>
    )
  const remove = async (x: SttModelInfo): Promise<void> => {
    const ok = await confirm({ title: `Delete ${x.label}?`, description: `Frees ${formatBytes(x.diskBytes ?? x.downloadBytes)}. You can download it again later.`, confirmLabel: 'Delete', tone: 'danger' })
    if (ok) await m.remove(x.id)
  }
  return (
    <div className="vs-models" id={controlId('voice.stt.model')} role="list" aria-label="Speech models">
      {list.map((x) => {
        const active = x.id === stt.model
        const busy = isBusy(x)
        return (
          <div key={x.id} role="listitem" className={['vs-model', active && x.state === 'installed' ? 'is-active' : ''].join(' ')} data-testid={`stt-model-${x.id}`}>
            <div>
              <div className="vs-model__name">
                {x.label}
                {active && x.state === 'installed' ? <Badge tone="accent">In use</Badge> : null}
                {x.state === 'installed' && !active ? <Badge tone="success">Downloaded</Badge> : null}
              </div>
              {!wizard ? <p className="vs-model__desc">{x.description}</p> : null}
              <p className="vs-model__facts">
                <span>{x.languages}</span>
                <span>{formatBytes(x.downloadBytes)} download</span>
                <span>~{x.ramMB} MB memory</span>
                {!wizard ? <span>{x.license}</span> : null}
              </p>
            </div>
            <div className="vs-model__actions">
              {x.state === 'not-installed' || x.state === 'error' ? (
                desktop ? (
                  <Button size="sm" variant={x.recommended ? 'primary' : 'secondary'} icon={x.state === 'error' ? <RotateCcw /> : <Download />} onClick={() => void m.download(x.id)}>
                    {x.state === 'error' ? 'Try again' : 'Download'}
                  </Button>
                ) : (
                  <span className="vs-note">Download on your PC</span>
                )
              ) : null}
              {busy && desktop ? (
                <Button size="sm" icon={<X />} onClick={() => void m.remove(x.id)}>
                  Cancel
                </Button>
              ) : null}
              {x.state === 'installed' && !active ? (
                <Button size="sm" variant="primary" disabled={!canEdit('voice.stt.model')} onClick={() => void patch({ voice: { stt: { model: x.id } } })}>
                  Use this model
                </Button>
              ) : null}
              {x.state === 'installed' && desktop ? <IconButton label={`Delete ${x.label}`} icon={<Trash2 />} size="sm" onClick={() => void remove(x)} /> : null}
            </div>
            {busy ? (
              <ProgressBar
                className="vs-model__progress"
                size="sm"
                label={x.state === 'downloading' ? 'Downloading' : x.state === 'verifying' ? 'Checking' : 'Unpacking'}
                value={modelProgressShare(x)}
                valueText={modelProgressText(x, formatBytes)}
              />
            ) : null}
            {x.state === 'error' && x.error ? <p className="vs-model__error" role="alert">{x.error.message}</p> : null}
          </div>
        )
      })}
      {dialog}
    </div>
  )
}

function CloudEngine(): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const p = cloudStt(stt.provider) ?? STT_CLOUD[0]
  const secret = `stt:${p.id}`
  const saved = useSecretSaved(secret)
  return (
    <>
      <Select<CloudSttId>
        label="Service"
        value={p.id}
        disabled={!canEdit('voice.stt.provider')}
        options={STT_CLOUD.map((x) => ({ value: x.id, label: x.label, description: x.note }))}
        onChange={(provider) => {
          const next = cloudStt(provider)
          if (next) void patch({ voice: { stt: { provider, model: next.defaultModel } } })
        }}
      />
      <PrivacyNote id={p.disclosure} />
      {desktop ? (
        <SecretInput
          id="vs-stt-key"
          label={`${p.label} key`}
          saved={saved}
          hint="Stored encrypted on this PC and sent only to this service."
          onSave={(value) => saveSecret(secret, value)}
          onRemove={() => removeSecret(secret)}
        />
      ) : !saved ? (
        <p className="vs-note">Add the {p.label} key in Vesper on your PC.</p>
      ) : null}
      <Select
        label="Model"
        value={effectiveCloudModel(p.id, stt.model)}
        disabled={!canEdit('voice.stt.model')}
        options={p.models.map((m) => ({ value: m, label: m, description: m === p.defaultModel ? 'Default' : undefined }))}
        onChange={(model) => void patch({ voice: { stt: { model } } })}
      />
    </>
  )
}

// ── listening ─────────────────────────────────────────────────────────────────────────────────

export function ListeningSettings({ wizard }: { wizard?: boolean }): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  return (
    <div className="vs-stack">
      {!wizard ? (
        <LabeledSegmented<Stt['mode']>
          id={controlId('voice.stt.mode')}
          label="How the mic button works"
          value={stt.mode}
          disabled={!canEdit('voice.stt.mode')}
          onChange={(mode) => void patch({ voice: { stt: { mode } } })}
          options={[
            { value: 'dictate', label: 'Dictate' },
            { value: 'ptt', label: 'Push to talk' },
            { value: 'conversation', label: 'Conversation' }
          ]}
          hint={
            stt.mode === 'dictate'
              ? 'Tap to talk; when you pause, the words go into the message box to edit before sending.'
              : stt.mode === 'ptt'
                ? 'Hold the button (or Space while it is focused) while you talk; letting go sends.'
                : 'Hands-free: what you say is sent after a pause, and Vesper listens again when it has answered.'
          }
        />
      ) : null}
      <SilenceSlider />
      <SilenceTryIt />
      {!wizard ? (
        <>
          <Switch
            id={controlId('voice.stt.autoSendDictation')}
            label="Send dictation automatically"
            description="In Dictate mode, send after the pause instead of waiting in the message box. Typing during the countdown still stops it."
            checked={stt.autoSendDictation}
            disabled={!canEdit('voice.stt.autoSendDictation')}
            onChange={(autoSendDictation) => void patch({ voice: { stt: { autoSendDictation } } })}
          />
          <Switch
            id={controlId('voice.stt.earcons')}
            label="Listening sounds"
            description="A soft chime when the mic starts and stops listening (push to talk and conversation)."
            checked={stt.earcons}
            disabled={!canEdit('voice.stt.earcons')}
            onChange={(earcons) => void patch({ voice: { stt: { earcons } } })}
          />
        </>
      ) : null}
    </div>
  )
}

function SilenceSlider(): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  return (
    <SettingSlider
      id={controlId('voice.stt.silenceMs')}
      label="Pause before sending"
      hint="How long you can pause before what you said counts as finished. Longer is more patient; shorter is snappier."
      value={stt.silenceMs}
      min={300}
      max={5000}
      step={100}
      format={formatSeconds}
      disabled={!canEdit('voice.stt.silenceMs')}
      onSave={(silenceMs) => void patch({ voice: { stt: { silenceMs } } })}
    />
  )
}

/** Talk here to feel the silence wait: the countdown ring and seconds left are live (research 07 §3.2 "try it"). */
export function SilenceTryIt(): ReactNode {
  const enabled = useStore((s) => s.settings?.voice.stt.enabled ?? false)
  const v = useStore((s) => s.voice)
  const [heard, setHeard] = useState<string | null>(null)
  const live = v.micMode !== null && v.micSessionUid === null
  const left = useSecondsLeft(live ? v.countdown : null)
  const text = live && v.partial ? v.partial : heard
  return (
    <div className="vs-tryit" data-testid="silence-tryit">
      <MicControl sessionUid={null} mode="dictate" size="lg" onText={(t) => setHeard(t)} />
      <div className="vs-tryit__text">
        <p className="vs-tryit__title">
          {!enabled
            ? 'Turn on voice input to try it'
            : live && v.countdown
              ? (
                  <>
                    Finishing in <span className="vs-tryit__count">{left.toFixed(1)} s</span> — keep talking to continue
                  </>
                )
              : live
                ? v.stt === 'transcribing'
                  ? 'Transcribing…'
                  : v.stt === 'warming-up'
                    ? 'Starting…'
                    : 'Listening… say a sentence, then pause'
                : 'Try it: tap the mic, say a sentence and pause'}
        </p>
        <p className={['vs-tryit__out', live ? 'is-live' : heard ? 'is-final' : ''].join(' ')} aria-live="polite">
          {text ?? 'Nothing is sent from here.'}
        </p>
      </div>
    </div>
  )
}

function useSecondsLeft(c: { endsAt: number } | null): number {
  const [left, setLeft] = useState(0)
  useEffect(() => {
    if (!c) return
    const tick = (): void => setLeft(Math.max(0, (c.endsAt - performance.now()) / 1000))
    tick()
    const h = window.setInterval(tick, 100)
    return () => window.clearInterval(h)
  }, [c])
  return left
}

// ── microphone ────────────────────────────────────────────────────────────────────────────────

function useAudioInputs(): { devices: MediaDeviceInfo[]; refresh(): void } {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const refresh = useCallback(() => {
    const md = navigator.mediaDevices
    if (!md?.enumerateDevices) return
    md.enumerateDevices().then(
      (all) => setDevices(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')),
      () => setDevices([])
    )
  }, [])
  useEffect(() => {
    refresh()
    const md = navigator.mediaDevices
    md?.addEventListener?.('devicechange', refresh)
    return () => md?.removeEventListener?.('devicechange', refresh)
  }, [refresh])
  return { devices, refresh }
}

export function MicSettings({ wizard }: { wizard?: boolean }): ReactNode {
  const prefs = useVoicePrefs()
  const inputs = useAudioInputs()
  const options = [
    { value: '', label: 'System default' },
    ...inputs.devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
  ]
  return (
    <div className="vs-stack">
      <Select
        id="vs-mic-device"
        label="Microphone"
        value={prefs.micDeviceId ?? ''}
        options={options}
        hint={inputs.devices.some((d) => !d.label) ? 'Names appear after you allow the microphone (run the test below).' : 'Saved for this device only.'}
        onChange={(id) => setVoicePrefs({ micDeviceId: id || null })}
      />
      <MicTest onStarted={inputs.refresh} />
      {!wizard ? (
        <div className="vs-grid2">
          <Switch id="vs-mic-echo" label="Echo cancellation" description="Removes Vesper's own voice from the mic." checked={prefs.echoCancellation} onChange={(echoCancellation) => setVoicePrefs({ echoCancellation })} />
          <Switch id="vs-mic-noise" label="Noise suppression" description="Softens fans and keyboard noise." checked={prefs.noiseSuppression} onChange={(noiseSuppression) => setVoicePrefs({ noiseSuppression })} />
        </div>
      ) : null}
    </div>
  )
}

/** Mic test: a live level meter (no speech recognition, nothing sent). */
export function MicTest({ onStarted }: { onStarted?: () => void }): ReactNode {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const [on, setOn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [heard, setHeard] = useState(false)
  const fillRef = useRef<HTMLDivElement>(null)
  const startedRef = useRef(false)

  const stop = useCallback(() => {
    setOn(false)
    if (startedRef.current && !micActive()) getMicCapture().stop()
    startedRef.current = false
  }, [])

  useEffect(() => () => stop(), [stop])

  useEffect(() => {
    if (!on) return
    const levels = createLevels()
    const input = getMicCapture().input
    let frame = 0
    let loud = 0
    const tick = (): void => {
      input.read(levels)
      const x = Math.min(1, Math.sqrt(levels.rms) * 1.6)
      fillRef.current?.style.setProperty('--lvl', x.toFixed(3))
      if (x > 0.35 && ++loud > 6) setHeard(true)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    const fill = fillRef.current
    return () => {
      cancelAnimationFrame(frame)
      fill?.style.setProperty('--lvl', '0')
    }
  }, [on])

  const start = async (): Promise<void> => {
    setError(null)
    setHeard(false)
    const pre = micPreflight()
    if (pre) return setError(pre)
    if (micActive()) return setError('busy')
    const p = getVoicePrefs()
    void unlockAudio()
    try {
      await getMicCapture().start({ deviceId: p.micDeviceId ?? undefined, echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGainControl })
      startedRef.current = true
      setOn(true)
      onStarted?.()
    } catch (e) {
      setError(toApiError(e).code)
    }
  }

  const help = error && error !== 'busy' ? micHelp(error, micPlaceOf(desktop)) : null
  return (
    <div className="vs-card" data-testid="mic-test">
      <div className="vs-card__head">
        <div>
          <p className="vs-card__title">Microphone test</p>
          <p className="vs-card__desc">{on ? (heard ? 'We can hear you.' : 'Say something — the bar should move.') : 'Check that Vesper hears you. Nothing is recorded or sent.'}</p>
        </div>
        <Button icon={on ? <MicOff /> : <Mic />} variant={on ? 'secondary' : 'primary'} size="sm" onClick={() => (on ? stop() : void start())}>
          {on ? 'Stop test' : 'Test microphone'}
        </Button>
      </div>
      <div className="vs-meter">
        <div className="vs-meter__bar" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={1} aria-valuenow={on ? undefined : 0}>
          <div ref={fillRef} className="vs-meter__fill" />
        </div>
        {heard ? (
          <p className="vs-result is-ok">
            <CircleCheck aria-hidden="true" />
            <span>Your microphone works.</span>
          </p>
        ) : null}
      </div>
      {error === 'busy' ? <p className="vs-note">The microphone is in use by a voice input right now.</p> : null}
      {help ? (
        <Callout tone="warning" title={help.title}>
          {help.body} {help.steps.join(' ')}
        </Callout>
      ) : null}
    </div>
  )
}

// ── barge-in + echo self-test ─────────────────────────────────────────────────────────────────

export function BargeInSettings(): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const prefs = useVoicePrefs()
  const voiceOk = stt.headphones || prefs.echoTest?.passed === true
  return (
    <div className="vs-stack">
      <div id={controlId('voice.stt.bargeIn')}>
        <RadioGroup<Stt['bargeIn']>
          label="Interrupting Vesper while it speaks"
          labelHidden
          value={stt.bargeIn}
          disabled={!canEdit('voice.stt.bargeIn')}
          onChange={(bargeIn) => void patch({ voice: { stt: { bargeIn } } })}
          options={[
            { value: 'tap', label: 'Tap or type (recommended)', description: 'Pressing the mic, Stop, or typing in the message box stops the voice.' },
            { value: 'voice', label: 'Just start talking', description: voiceOk ? 'Talking over Vesper stops it. Works best with headphones.' : 'Needs headphones or a passed echo test, so Vesper doesn’t interrupt itself.', disabled: !voiceOk },
            { value: 'off', label: 'Only the Stop button', description: 'Typing and the mic never cut a reply short.' }
          ]}
        />
      </div>
      <Switch
        id={controlId('voice.stt.headphones')}
        label="I use headphones"
        description="With headphones the mic can’t hear Vesper, so talking over it is safe."
        checked={stt.headphones}
        disabled={!canEdit('voice.stt.headphones')}
        onChange={(headphones) => void patch({ voice: { stt: { headphones } } })}
      />
      <EchoTest />
    </div>
  )
}

/** Plays a 2 s chirp through the voice output while listening and checks whether the mic hears it (07 C15). */
export function EchoTest(): ReactNode {
  const prefs = useVoicePrefs()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<EchoVerdict | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<(() => void) | null>(null)

  useEffect(() => () => abort.current?.(), [])

  const run = async (): Promise<void> => {
    setError(null)
    setResult(null)
    const pre = micPreflight()
    if (pre) return setError(micHelp(pre, micPlaceOf(false)).title)
    if (micActive()) return setError('Stop the voice input first.')
    setRunning(true)
    try {
      const verdict = await echoTestRun((a) => (abort.current = a))
      setResult(verdict)
      setVoicePrefs({ echoTest: { passed: verdict.passed, at: Date.now(), ratio: Math.round(verdict.ratio * 100) / 100 } })
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') setError(toApiError(e).message)
    } finally {
      abort.current = null
      setRunning(false)
    }
  }

  const last = result ?? (prefs.echoTest ? { passed: prefs.echoTest.passed, ratio: prefs.echoTest.ratio } : null)
  return (
    <div className="vs-card" data-testid="echo-test">
      <div className="vs-card__head">
        <div>
          <p className="vs-card__title">Echo test</p>
          <p className="vs-card__desc">Plays a short sweep through your speakers while listening, to see whether the mic picks up Vesper’s voice.</p>
        </div>
        <Button size="sm" icon={<Ear />} loading={running} onClick={() => void run()}>
          {running ? 'Listening…' : last ? 'Run again' : 'Run echo test'}
        </Button>
      </div>
      {last ? (
        last.passed ? (
          <p className="vs-result is-ok" role="status">
            <CircleCheck aria-hidden="true" />
            <span>The mic barely hears the speakers — you can interrupt Vesper just by talking.</span>
          </p>
        ) : (
          <p className="vs-result is-bad" role="status">
            <TriangleAlert aria-hidden="true" />
            <span>The mic hears the speakers ({last.ratio.toFixed(1)}× the room’s quiet). Use headphones to interrupt by voice.</span>
          </p>
        )
      ) : null}
      {error ? <p className="vs-note" role="alert">{error}</p> : null}
      <p className="vs-note">
        <Headphones aria-hidden="true" className="vs-inline-icon" /> Headphones always pass.
      </p>
    </div>
  )
}

/** The measurement: 0.3 s settle, 0.7 s room floor, then the chirp; levels sampled every 30 ms. */
async function echoTestRun(setAbort: (a: () => void) => void): Promise<EchoVerdict> {
  const mic = getMicCapture()
  const engine = getAudioEngine()
  const p = getVoicePrefs()
  const replyId = `echo-test-${Date.now()}`
  const timers = new Set<number>()
  const offs: Array<() => void> = []
  let aborted = false
  const cleanup = (): void => {
    for (const h of timers) window.clearInterval(h)
    timers.clear()
    for (const off of offs.splice(0)) off()
    engine.stop(replyId)
    if (!micActive()) mic.stop()
  }
  setAbort(() => {
    aborted = true
    cleanup()
  })
  await unlockAudio()
  await mic.start({ deviceId: p.micDeviceId ?? undefined, echoCancellation: p.echoCancellation, noiseSuppression: p.noiseSuppression, autoGainControl: p.autoGainControl })
  const levels = createLevels()
  const sample = (ms: number, until?: Promise<void>): Promise<number[]> =>
    new Promise((resolve) => {
      const out: number[] = []
      const t0 = performance.now()
      let done = false
      const h = window.setInterval(() => {
        mic.input.read(levels)
        out.push(levels.rms)
        if (!done && performance.now() - t0 >= ms) finish()
      }, 30)
      timers.add(h)
      const finish = (): void => {
        done = true
        window.clearInterval(h)
        timers.delete(h)
        resolve(out)
      }
      void until?.then(finish)
    })
  try {
    await sample(300)
    const floor = await sample(700)
    if (aborted) throw new DOMException('aborted', 'AbortError')
    const ended = new Promise<void>((resolve) => {
      offs.push(engine.on('replyEnd', (e) => e.replyId === replyId && resolve()))
    })
    const started = new Promise<void>((resolve) => {
      offs.push(engine.on('chunkStart', (e) => e.replyId === replyId && resolve()))
    })
    engine.enqueue({ sessionUid: '', evSeq: 0, replyId, index: 0, src: [0, 0], text: '', spoken: '', timeline: null, durationMs: 2000, mime: 'audio/wav', instant: false, final: true }, chirpWav(2000))
    await Promise.race([started, new Promise((r) => window.setTimeout(r, 1500))])
    const during = await sample(2600, ended)
    if (aborted) throw new DOMException('aborted', 'AbortError')
    return echoVerdict(floor, during)
  } finally {
    cleanup()
  }
}

// ── advanced ──────────────────────────────────────────────────────────────────────────────────

export function AdvancedVoiceIn(): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const hotkey = useStore((s) => s.settings?.voice.globalHotkey ?? null)
  const [key, setKey] = useState(hotkey ?? '')
  useEffect(() => setKey(hotkey ?? ''), [hotkey])
  const [unloading, setUnloading] = useState(false)
  return (
    <div className="vs-stack">
      <div className="vs-grid2">
        <SettingSlider
          id={controlId('voice.stt.vadThreshold')}
          label="Speech sensitivity"
          hint="Lower hears quiet voices; higher ignores more background noise."
          value={stt.vadThreshold}
          min={0.1}
          max={0.95}
          step={0.05}
          format={(x) => x.toFixed(2)}
          disabled={!canEdit('voice.stt.vadThreshold')}
          onSave={(vadThreshold) => void patch({ voice: { stt: { vadThreshold } } })}
        />
        <SettingSlider
          id={controlId('voice.stt.preRollMs')}
          label="Keep before speech"
          hint="Audio kept from just before you start, so first words aren’t clipped."
          value={stt.preRollMs}
          min={0}
          max={1000}
          step={50}
          format={(x) => `${x} ms`}
          disabled={!canEdit('voice.stt.preRollMs')}
          onSave={(preRollMs) => void patch({ voice: { stt: { preRollMs } } })}
        />
        <SettingSlider
          id={controlId('voice.stt.maxUtteranceSec')}
          label="Longest utterance"
          hint="Speech longer than this is finished anyway."
          value={stt.maxUtteranceSec}
          min={5}
          max={300}
          step={5}
          format={(x) => `${x} s`}
          disabled={!canEdit('voice.stt.maxUtteranceSec')}
          onSave={(maxUtteranceSec) => void patch({ voice: { stt: { maxUtteranceSec } } })}
        />
        <SettingSlider
          id={controlId('voice.stt.unloadAfterMin')}
          label="Unload the speech model after"
          hint="Frees memory when voice input hasn’t been used for a while."
          value={stt.unloadAfterMin}
          min={0}
          max={120}
          step={1}
          format={(x) => (x === 0 ? 'Right away' : `${x} min`)}
          disabled={!canEdit('voice.stt.unloadAfterMin')}
          onSave={(unloadAfterMin) => void patch({ voice: { stt: { unloadAfterMin } } })}
        />
      </div>
      <div>
        <Button
          size="sm"
          loading={unloading}
          onClick={() => {
            setUnloading(true)
            api('POST /api/stt/unload').then(
              () => toast.success('Voice models unloaded.'),
              (e: unknown) => toast.error(toApiError(e).message)
            ).finally(() => setUnloading(false))
          }}
        >
          Unload voice models now
        </Button>
      </div>
      {desktop ? (
        <TextField
          id={controlId('voice.globalHotkey')}
          label="Push-to-talk hotkey (works everywhere on this PC)"
          placeholder="Off — for example Ctrl+Alt+Space"
          value={key}
          maxLength={40}
          hint="Press it in any app to talk to the open chat, press it again to send. While it’s set, Vesper keeps its window loaded in the tray so the key always works. Games may use the same keys — pick something unusual."
          onChange={(e) => setKey(e.target.value)}
          onBlur={() => {
            const next = key.trim() || null
            if (next !== hotkey) void patch({ voice: { globalHotkey: next } })
          }}
        />
      ) : null}
    </div>
  )
}
