/**
 * Settings → Voice out (R12, R13, R14, R20; 07 A2, C22, D12): the voice service, its key (the voices list fills by
 * itself once the key is saved), voice and model, "Play sample", voice tones, playback, Talk mode, Advanced.
 */
import type { ReactNode } from 'react'
import { Disclosure } from '../../components/Disclosure'
import { Switch } from '../../components/Switch'
import type { SettingsSectionProps } from '../settings/sections'
import { useStore } from '../../lib/store'
import { useCanEdit, useSettingsPatch } from './settings/hooks'
import { controlId } from './settings/ids.logic'
import { DesktopOnlyNote, PageHead, Section } from './settings/parts'
import { AdvancedVoiceOut, PlaybackSettings, ProviderPicker, ProviderPrivacy, ToneSettings, useTts, VoiceSetup } from './settings/VoiceOutParts'
import './settings/voice-settings.css'

export default function SettingsVoiceOut({ advanced }: SettingsSectionProps): ReactNode {
  const tts = useTts()
  const patch = useSettingsPatch()
  const canEdit = useCanEdit()
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  return (
    <div className="vs-page" data-testid="settings-voice-out">
      <PageHead title="Voice out" lead="How Vesper speaks its replies — the voice, its tone, and how text and voice come together." />
      <div className="vs-master">
        <Switch
          id={controlId('voice.tts.enabled')}
          label="Voice replies"
          description={tts.enabled ? 'Replies are spoken on devices with “Speak replies” on.' : 'Off — you can still pick a voice and try it first.'}
          checked={tts.enabled}
          disabled={!canEdit('voice.tts.enabled')}
          onChange={(enabled) => void patch({ voice: { tts: { enabled } } })}
        />
      </div>
      {!desktop ? <DesktopOnlyNote what="The voice service and its key" /> : null}

      <Section title="Voice" description="Pick a service, add your key, and choose how Vesper sounds.">
        <ProviderPicker />
        <ProviderPrivacy />
        <VoiceSetup />
        {/* H-v11-tone: right under the voice choice — the tone mode depends on the voice, and it is found here. */}
        <ToneSettings />
      </Section>

      <Section title="Playback">
        <PlaybackSettings />
      </Section>

      <Section title="Advanced" className="vs-section--advanced">
        <Disclosure summary="More voice options" defaultOpen={advanced} variant="card">
          <AdvancedVoiceOut />
        </Disclosure>
      </Section>
    </div>
  )
}
