/**
 * Setup wizard → step 5, Microphone (07 D11, R19): allow the mic and watch the level meter, download the speech model
 * (it keeps downloading in the background), set the pause before sending and try it. Optional; saves as it goes.
 * The wizard's one navigation bar drives it (useWizardNav): Continue turns voice input on first. So does the model in
 * use becoming ready on this step (ModelList, P23), so the switch, "In use" and the try-out agree before Continue.
 */
import type { ReactNode } from 'react'
import { Callout } from '../../components/Callout'
import { Switch } from '../../components/Switch'
import { useStore } from '../../lib/store'
import { useWizardNav } from '../wizard/nav'
import type { WizardStepProps } from '../wizard/steps'
import { micHelp } from './mic.logic'
import { micPlaceOf, micPreflight } from './micSession'
import { useSettingsPatch } from './settings/hooks'
import { controlId } from './settings/ids.logic'
import { PrivacyNote, Section } from './settings/parts'
import { ListeningSettings, MicTest, ModelList, useStt } from './settings/VoiceInParts'
import './settings/voice-settings.css'

export default function WizardVoiceIn(_props: WizardStepProps): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const assistant = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const insecure = micPreflight() === 'insecure_context'
  const help = insecure ? micHelp('insecure_context', micPlaceOf(true)) : null

  useWizardNav({ onContinue: async () => (stt.enabled ? true : await patch({ voice: { stt: { enabled: true } } })) })

  return (
    <div className="vw" data-testid="wizard-voice-in">
      <header className="vw__head">
        <p className="vw__eyebrow">Microphone · optional</p>
        <h1 className="vw__title wiz-step__title" tabIndex={-1}>
          Talk to {assistant}
        </h1>
        <p className="vw__lead">Speak instead of typing. Your voice is turned into text on this PC by an open-source model — the audio never leaves it.</p>
      </header>
      {help ? (
        <Callout tone="warning" title={help.title}>
          {help.body}
        </Callout>
      ) : null}
      <div className="vs-master" data-setting="voice.stt.enabled">
        <Switch
          id={controlId('voice.stt.enabled')}
          label="Use voice input"
          description="Shows the mic button next to the message box."
          checked={stt.enabled}
          onChange={(enabled) => void patch({ voice: { stt: { enabled } } })}
        />
      </div>
      <MicTest />
      <Section title="Speech model" description="A one-time download. It continues in the background while you finish setup.">
        <ModelList wizard />
        <PrivacyNote id="local-stt" compact />
      </Section>
      <Section title="Listening" description="Try how long a pause ends what you said.">
        <ListeningSettings wizard />
      </Section>
    </div>
  )
}
