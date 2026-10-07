/**
 * Setup wizard → step 4, Voice (07 D11, R12, R13): choose a voice service, add the key — the voices fill in by
 * themselves — pick a voice, hear a sample, choose the voice tones (H-v11-tone) and see why the tone goes at the start
 * (07 A2). Optional; saves as it goes.
 * The wizard's one navigation bar drives it (useWizardNav): "Use this voice" turns voice replies on first.
 */
import type { ReactNode } from 'react'
import { baseUrlProblem } from '@shared/settings'
import { useStore } from '../../lib/store'
import { useWizardNav } from '../wizard/nav'
import type { WizardStepProps } from '../wizard/steps'
import { useSecretSaved, useSettingsPatch } from './settings/hooks'
import { ProviderPicker, ProviderPrivacy, ToneSettings, useTts, VoiceSetup } from './settings/VoiceOutParts'
import { providerMeta } from './voices.logic'
import './settings/voice-settings.css'

export default function WizardVoiceOut(_props: WizardStepProps): ReactNode {
  const tts = useTts()
  const patch = useSettingsPatch()
  const assistant = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const meta = providerMeta(tts.provider)
  const keySaved = useSecretSaved(meta.secret)
  const ready = (!meta.needsUrl || (!!tts.baseUrl && baseUrlProblem(tts.baseUrl) === null)) && (meta.secret === null || keySaved || meta.id === 'openai-compatible') && !!tts.voiceId

  useWizardNav({
    canContinue: ready,
    continueLabel: 'Use this voice',
    blockedReason: meta.secret && !keySaved ? 'Add the key and choose a voice to continue, or skip for now.' : 'Choose a voice to continue, or skip for now.',
    onContinue: async () => (tts.enabled ? true : await patch({ voice: { tts: { enabled: true } } }))
  })

  return (
    <div className="vw" data-testid="wizard-voice-out">
      <header className="vw__head">
        <p className="vw__eyebrow">Voice · optional</p>
        <h1 className="vw__title wiz-step__title" tabIndex={-1}>
          Give {assistant} a voice
        </h1>
        <p className="vw__lead">Replies can be spoken aloud, with the words appearing as they are said. Everything here can be changed later in Settings → Voice out.</p>
      </header>
      <ProviderPicker compact />
      <ProviderPrivacy compact />
      <VoiceSetup wizard />
      <ToneSettings wizard />
    </div>
  )
}
