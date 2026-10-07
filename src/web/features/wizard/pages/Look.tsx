/**
 * Setup wizard → Look & presence (07 D11 step 7): theme, accent, the Star's style (incl. Off) and motion; on the
 * desktop, start with Windows / keep running in the tray — asked, both off by default.
 */
import type { ReactNode } from 'react'
import { useStore } from '../../../lib/store'
import { AccentSetting, StarStyleSetting, ThemeSetting } from '../../settings/fields'
import { SettingsGroup, SwitchSetting } from '../../settings/ui'
import type { WizardStepProps } from '../steps'

export default function WizardLook(_props: WizardStepProps): ReactNode {
  const portable = useStore((s) => s.bootstrap?.portable ?? false)
  return (
    <div className="wiz-step">
      <header className="wiz-step__head">
        <h1 className="wiz-step__title" tabIndex={-1}>
          Make it yours
        </h1>
        <p className="wiz-step__lead">Changes apply right away, so you can see them as you go.</p>
      </header>
      <SettingsGroup>
        <ThemeSetting />
        <AccentSetting />
        <SwitchSetting setting="appearance.reduceMotion" label="Reduce motion" description="Fades and slides become instant, and the Star moves gently." />
      </SettingsGroup>
      <SettingsGroup>
        <StarStyleSetting />
      </SettingsGroup>
      <SettingsGroup title="On this PC">
        <SwitchSetting
          setting="desktop.startWithWindows"
          label="Start with Windows"
          disabled={portable}
          description={portable ? 'Not available in the portable version.' : 'Vesper starts quietly in the tray when you sign in.'}
        />
        <SwitchSetting setting="desktop.closeToTray" label="Keep running in the tray when closed" description="So your phone can still reach Vesper." />
      </SettingsGroup>
    </div>
  )
}
