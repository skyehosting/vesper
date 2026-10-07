/**
 * Voice and model for this chat (01 "Session panel"): a voice override (voice + TTS model from the provider's lists,
 * 07 C22) and the AI model override (the same picker as the top bar's model chip). "Default" clears an override.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { RotateCcw, Volume2 } from 'lucide-react'
import type { ModelInfo, Session, Voice } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { Combobox } from '../../components/Combobox'
import { LeavesPcBadge } from '../../components/Badge'
import { Select } from '../../components/Select'
import { toApiError } from '../../lib/errors.logic'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { getTts } from '../sessions/cache'
import { ModelPicker } from '../sessions/SessionHeader'
import { trySession } from '../sessions/data'
import { useSpeakReplies, setSpeakReplies } from '../sessions/speakReplies'
import { Switch } from '../../components/Switch'

const DEFAULT = '__default__'
const LOCAL_TTS = new Set(['windows', 'piper'])

export function VoiceSection({ session }: { session: Session }): ReactNode {
  const tts = useStore((s) => s.settings?.voice.tts)
  const speak = useSpeakReplies()
  const provider = session.voice?.provider ?? tts?.provider ?? 'windows'
  const [voices, setVoices] = useState<Voice[] | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!tts?.enabled) return
    let alive = true
    setVoices(null)
    setError(null)
    getTts(provider)
      .then((c) => {
        if (!alive) return
        setVoices(c.voices)
        setModels(c.models)
      })
      .catch((e: unknown) => {
        if (alive) setError(toApiError(e).message)
      })
    return () => {
      alive = false
    }
  }, [provider, tts?.enabled])

  const defaultVoice = voices?.find((v) => v.id === tts?.voiceId)?.name ?? tts?.voiceId ?? 'not set'
  const voiceOptions = [
    { value: DEFAULT, label: `Default (${defaultVoice})` },
    ...(voices ?? []).map((v) => ({ value: v.id, label: v.name, description: [v.category, v.language, v.gender, v.description].filter(Boolean).join(' · ') || undefined }))
  ]

  return (
    <div className="psec__body">
      {!tts?.enabled ? (
        <div className="psec__setup">
          <p className="psec__hint">Voice replies aren’t set up yet. Pick a voice provider (Windows voices work offline) to hear the AI.</p>
          <Button size="sm" variant="secondary" icon={<Volume2 />} onClick={() => navigate('/settings/voice-out')}>
            Set up voice
          </Button>
        </div>
      ) : (
        <>
          <Switch label="Speak replies on this device" description="Applies to every chat on this device." checked={speak.on} onChange={setSpeakReplies} />
          <Combobox
            label="Voice for this chat"
            labelExtra={LOCAL_TTS.has(provider) ? undefined : <LeavesPcBadge service={provider === 'elevenlabs' ? 'ElevenLabs' : provider === 'openai' ? 'OpenAI' : 'your voice provider'} what="reply text" />}
            value={session.voice?.voiceId ?? DEFAULT}
            options={voiceOptions}
            loading={voices === null && !error}
            emptyText={error ? `Couldn't list voices: ${error}` : 'No voice matches.'}
            onChange={(v) => {
              if (v === null) return
              void trySession(session.uid, { voice: v === DEFAULT ? null : { provider, voiceId: v, ...(session.voice?.model ? { model: session.voice.model } : {}) } })
            }}
          />
          {session.voice && models.length > 1 ? (
            <Select
              label="Voice model"
              value={session.voice.model ?? DEFAULT}
              options={[{ value: DEFAULT, label: `Default (${tts.model ?? 'provider default'})` }, ...models.map((m) => ({ value: m.id, label: m.label ?? m.id, description: m.fast ? 'low latency' : undefined }))]}
              onChange={(m) => {
                if (!session.voice) return
                const { model: _drop, ...rest } = session.voice
                void trySession(session.uid, { voice: m === DEFAULT ? rest : { ...rest, model: m } })
              }}
            />
          ) : null}
          {session.voice ? (
            <div className="psec__row">
              <Button size="sm" variant="ghost" icon={<RotateCcw />} onClick={() => void trySession(session.uid, { voice: null })}>
                Use the default voice
              </Button>
            </div>
          ) : null}
        </>
      )}
      <div className="psec__divider" />
      <ModelPicker session={session} />
    </div>
  )
}
