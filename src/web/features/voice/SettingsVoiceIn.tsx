/**
 * Settings → Voice in (R19, R20; 07 C15, C17, D6, D8, B12): speech recognition (local models or a cloud service), how
 * the mic button works, the silence wait with a live try-it area, the microphone, interrupting, the echo self-test.
 */
import type { ReactNode } from 'react'
import { Callout } from '../../components/Callout'
import { Disclosure } from '../../components/Disclosure'
import { Switch } from '../../components/Switch'
import type { SettingsSectionProps } from '../settings/sections'
import { useStore } from '../../lib/store'
import { micHelp } from './mic.logic'
import { micPlaceOf, micPreflight } from './micSession'
import { useCanEdit, useSettingsPatch } from './settings/hooks'
import { controlId } from './settings/ids.logic'
import { PageHead, Section } from './settings/parts'
import { AdvancedVoiceIn, BargeInSettings, EngineSettings, ListeningSettings, MicSettings, useStt } from './settings/VoiceInParts'
import './settings/voice-settings.css'

export default function SettingsVoiceIn({ advanced }: SettingsSectionProps): ReactNode {
  const stt = useStt()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const insecure = micPreflight() === 'insecure_context'
  const help = insecure ? micHelp('insecure_context', micPlaceOf(desktop)) : null
  return (
    <div className="vs-page" data-testid="settings-voice-in">
      <PageHead title="Voice in" lead="Talk instead of typing. Your voice is turned into text — on this PC unless you choose a cloud service." />
      <div className="vs-master">
        <Switch
          id={controlId('voice.stt.enabled')}
          label="Voice input"
          description={stt.enabled ? 'The mic button appears next to the message box.' : 'Off — the mic button stays hidden until you turn this on.'}
          checked={stt.enabled}
          disabled={!canEdit('voice.stt.enabled')}
          onChange={(enabled) => void patch({ voice: { stt: { enabled } } })}
        />
      </div>
      {help ? (
        <Callout tone="warning" title={help.title}>
          {help.body} {help.steps.join(' ')}
        </Callout>
      ) : null}

      <Section title="Speech recognition">
        <EngineSettings />
      </Section>

      <Section title="Listening" description="How the mic button behaves and how long a pause ends what you said.">
        <ListeningSettings />
      </Section>

      <Section title="Microphone" description="These choices are saved for this device only.">
        <MicSettings />
      </Section>

      <Section title="Interrupting" description="Stopping Vesper mid-reply keeps what it already said and lets you talk.">
        <BargeInSettings />
      </Section>

      <Section title="Advanced" className="vs-section--advanced">
        <Disclosure summary="More voice input options" defaultOpen={advanced} variant="card">
          <AdvancedVoiceIn />
        </Disclosure>
      </Section>
    </div>
  )
}
