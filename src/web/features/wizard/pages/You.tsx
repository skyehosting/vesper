/**
 * Setup wizard → You (07 D11 step 2): your name, the assistant's name, the time zone (detected, shown, editable) and
 * the clock — what the AI uses to know who it talks to and how long ago things were said (R10). Saved as typed.
 */
import type { ReactNode } from 'react'
import { useStore } from '../../../lib/store'
import { ClockSetting, TimeZoneSetting } from '../../settings/fields'
import { SettingsGroup, TextSetting } from '../../settings/ui'
import type { WizardStepProps } from '../steps'

export default function WizardYou(_props: WizardStepProps): ReactNode {
  const assistant = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  return (
    <div className="wiz-step">
      <header className="wiz-step__head">
        <h1 className="wiz-step__title" tabIndex={-1}>
          Nice to meet you
        </h1>
        <p className="wiz-step__lead">
          {assistant} sees your local time with every message, so it knows when something was said — yesterday, or a month ago.
        </p>
      </header>
      <SettingsGroup>
        <TextSetting setting="profile.userName" label="What should I call you?" placeholder="Your name" hint="Optional. Used in greetings and so the AI knows who it's talking to." />
        <TextSetting setting="profile.assistantName" label="And what should you call me?" placeholder="Vesper" validate={(v) => (v.trim() ? null : 'Give the assistant a name.')} />
        <TimeZoneSetting label="Your time zone" />
        <ClockSetting />
      </SettingsGroup>
    </div>
  )
}
