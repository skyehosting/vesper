/**
 * Setup wizard → Summary (07 D11 step 8): every step's outcome with an Edit link back to it; skipped steps say so
 * (they become the setup checklist). Continue unlocks audio inside the click (the finale speaks right after).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { CircleCheck, CircleDashed, CircleMinus, Pencil } from 'lucide-react'
import { presetById } from '@shared/presets'
import type { SttModelInfo } from '@shared/models'
import type { Voice } from '@shared/types/domain'
import { Button } from '../../../components/Button'
import { getAudioEngine } from '../../../lib/audio'
import { api } from '../../../lib/api'
import { useStore } from '../../../lib/store'
import { ACCENT_INFO } from '../../settings/fields'
import { secretName } from '../../settings/providers/providers.logic'
import { useWizardNav } from '../nav'
import { wizardStep, type WizardStepProps } from '../steps'

type RowState = 'ok' | 'off' | 'skipped' | 'todo'

const TTS_LABEL: Record<string, string> = { elevenlabs: 'ElevenLabs', openai: 'OpenAI', windows: 'Windows voices', 'openai-compatible': 'Custom voice server', piper: 'Piper' }
const STT_LABEL: Record<string, string> = { local: 'On this PC', openai: 'OpenAI', groq: 'Groq', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs' }
const ACCESS_LABEL: Record<string, string> = { local: 'This PC only', lan: 'This PC and your local network', tailscale: 'Your devices, anywhere (Tailscale)' }
const STAR_LABEL: Record<string, string> = { armilla: 'Armilla', orb: 'Orb', nebula: 'Nebula', minimal2d: 'Minimal', off: 'Off' }
const THEME_LABEL: Record<string, string> = { dark: 'Dark', light: 'Light', system: 'System' }

/** Voice name and speech-model state for the summary (fetched once; aborted on unmount). */
function useDetails(ttsProvider: string | null, voiceId: string | null, sttLocal: boolean): { voice: Voice | null; model: SttModelInfo[] | null } {
  const [voice, setVoice] = useState<Voice | null>(null)
  const [model, setModel] = useState<SttModelInfo[] | null>(null)
  useEffect(() => {
    if (!ttsProvider || !voiceId) return
    const ctl = new AbortController()
    api('GET /api/tts/voices', { query: { provider: ttsProvider }, signal: ctl.signal })
      .then((r) => setVoice(r.voices.find((v) => v.id === voiceId) ?? null))
      .catch(() => undefined)
    return () => ctl.abort()
  }, [ttsProvider, voiceId])
  useEffect(() => {
    if (!sttLocal) return
    const ctl = new AbortController()
    api('GET /api/stt/models', { signal: ctl.signal })
      .then(setModel)
      .catch(() => undefined)
    return () => ctl.abort()
  }, [sttLocal])
  return { voice, model }
}

export default function WizardSummary({ onGoTo }: WizardStepProps): ReactNode {
  const s = useStore((st) => st.settings)
  const secrets = useStore((st) => st.bootstrap?.secretsSet ?? [])
  const tts = s?.voice.tts
  const stt = s?.voice.stt
  const details = useDetails(tts?.enabled ? tts.provider : null, tts?.enabled ? tts.voiceId : null, !!stt?.enabled && stt.provider === 'local')
  const assistant = s?.profile.assistantName || 'Vesper'

  useWizardNav({
    continueLabel: `Meet ${assistant}`,
    onContinue: () => {
      // Inside the click: the finale's greeting may play without another gesture.
      void getAudioEngine().unlock()
      return true
    }
  })

  if (!s) return null
  const skipped = s.wizard.skipped
  const profile = s.llm.profiles.find((p) => p.id === s.llm.defaultProfile) ?? s.llm.profiles[0]
  const preset = profile ? presetById(profile.preset) : null
  const providerOk = !!profile && !!profile.model && (!preset?.keyRequired || secrets.includes(secretName(profile.id)))
  const state = (id: string, on: boolean): RowState => (on ? 'ok' : skipped.includes(id) ? 'skipped' : 'off')
  const sttModel = details.model?.find((m) => m.id === stt?.model)

  const rows: { id: string; state: RowState; value: ReactNode }[] = [
    {
      id: 'provider',
      state: providerOk ? 'ok' : 'todo',
      value: profile ? `${profile.label}${profile.model ? ` · ${profile.model}` : ' · no model chosen'}` : 'Not connected yet'
    },
    {
      id: 'you',
      state: s.profile.userName ? 'ok' : state('you', false),
      value: `${s.profile.userName || 'No name given'} · ${s.profile.timeZone || 'automatic time zone'} · ${s.profile.clock === '12h' ? '12-hour' : '24-hour'} clock`
    },
    { id: 'memory', state: state('memory', s.memory.enabled), value: s.memory.enabled ? `On · Voyage ${s.memory.voyage.embedModel}` : 'Off' },
    {
      id: 'voice-out',
      state: state('voice-out', !!tts?.enabled),
      value: tts?.enabled ? `${TTS_LABEL[tts.provider] ?? tts.provider}${details.voice ? ` · ${details.voice.name}` : tts.voiceId ? '' : ' · no voice chosen'}` : 'Off'
    },
    {
      id: 'voice-in',
      state: state('voice-in', !!stt?.enabled),
      value: stt?.enabled
        ? `${STT_LABEL[stt.provider] ?? stt.provider}${sttModel ? ` · ${sttModel.label.replace(/\s*\(.*\)$/, '')}${sttModel.state === 'installed' ? '' : sttModel.state === 'downloading' ? ' · downloading' : ' · not downloaded yet'}` : ''}`
        : 'Off'
    },
    { id: 'access', state: skipped.includes('access') ? 'skipped' : 'ok', value: ACCESS_LABEL[s.access.mode] ?? s.access.mode },
    {
      id: 'look',
      state: skipped.includes('look') ? 'skipped' : 'ok',
      value: `${THEME_LABEL[s.appearance.theme]} · ${ACCENT_INFO[s.appearance.accent].label} · Star: ${STAR_LABEL[s.appearance.star.style]}`
    }
  ]

  return (
    <div className="wiz-step">
      <header className="wiz-step__head">
        <h1 className="wiz-step__title" tabIndex={-1}>
          All set — here&rsquo;s your setup
        </h1>
        <p className="wiz-step__lead">Change anything now, or later in Settings. Skipped steps wait on a short checklist in your first chat.</p>
      </header>
      <ul className="wiz-summary" aria-label="Your setup">
        {rows.map((r) => {
          const step = wizardStep(r.id)
          const Icon = step?.icon
          return (
            <li key={r.id} className={`wiz-summary__row wiz-summary__row--${r.state}`} data-summary={r.id}>
              <span className="wiz-summary__icon" aria-hidden="true">
                {Icon ? <Icon /> : null}
              </span>
              <span className="wiz-summary__text">
                <span className="wiz-summary__title">{step?.title}</span>
                <span className="wiz-summary__value">{r.value}</span>
              </span>
              <span className={`wiz-summary__state wiz-summary__state--${r.state}`}>
                {r.state === 'ok' ? <CircleCheck aria-hidden="true" /> : r.state === 'skipped' ? <CircleDashed aria-hidden="true" /> : <CircleMinus aria-hidden="true" />}
                {r.state === 'ok' ? 'Ready' : r.state === 'skipped' ? 'Skipped' : r.state === 'todo' ? 'Needs attention' : 'Off'}
              </span>
              <Button size="sm" variant="ghost" icon={<Pencil />} aria-label={`Edit ${step?.title ?? r.id}`} onClick={() => onGoTo?.(r.id)}>
                Edit
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
