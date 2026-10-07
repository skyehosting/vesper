/** Settings → General: names, time zone and clock (R10), how Vesper runs on this PC, and "Run setup again" (07 D11). */
import type { ReactNode } from 'react'
import { Wand2 } from 'lucide-react'
import { Button } from '../../../components/Button'
import { navigate } from '../../../lib/router'
import { useStore } from '../../../lib/store'
import { CLOSE_TO_TRAY_LABEL } from '../catalog.logic'
import { ClockSetting, TimeZoneSetting } from '../fields'
import type { SettingsSectionProps } from '../sections'
import { ReadOnlyNotice, SettingRow, SettingsAdvanced, SettingsGroup, SettingsPageHeader, SwitchSetting, TextSetting } from '../ui'

const PATHS = ['profile.userName', 'profile.assistantName', 'profile.timeZone', 'profile.clock', 'desktop.closeToTray', 'desktop.startWithWindows']

export default function SettingsGeneral({ advanced }: SettingsSectionProps): ReactNode {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const portable = useStore((s) => s.bootstrap?.portable ?? false)
  return (
    <div className="spage">
      <SettingsPageHeader title="General" description="Who you are to Vesper, your time zone, and how Vesper runs on this PC." />
      <ReadOnlyNotice paths={PATHS} />

      <SettingsGroup title="You and Vesper" description="Names are used in conversations; the AI also knows your local time with every message.">
        <TextSetting setting="profile.userName" label="Your name" placeholder="What should Vesper call you?" />
        <TextSetting setting="profile.assistantName" label="Assistant's name" placeholder="Vesper" validate={(v) => (v.trim() ? null : 'Give the assistant a name.')} />
        <TimeZoneSetting />
        <ClockSetting />
      </SettingsGroup>

      <SettingsGroup title="On this PC" description={desktop ? undefined : 'These apply to the Vesper app on your PC.'}>
        <SwitchSetting setting="desktop.closeToTray" label={CLOSE_TO_TRAY_LABEL} description="Your other devices can still reach Vesper while its window is closed." />
        <SwitchSetting
          setting="desktop.startWithWindows"
          label="Start with Windows"
          disabled={portable}
          description={portable ? 'Not available in the portable version — install Vesper to use it.' : 'Vesper starts quietly in the tray when you sign in to Windows.'}
        />
      </SettingsGroup>

      {desktop ? (
        <SettingsGroup title="Setup">
          <SettingRow inline>
            <div className="set-row__text">
              <span className="set-row__label">Run setup again</span>
              <span className="set-row__desc">Walk through the setup steps again. Your current settings are kept as the starting point.</span>
            </div>
            <Button icon={<Wand2 />} onClick={() => navigate('/setup?rerun=1')}>
              Run setup again
            </Button>
          </SettingRow>
        </SettingsGroup>
      ) : null}

      <SettingsAdvanced open={advanced}>
        <SettingsGroup>
          <SwitchSetting setting="desktop.startInBackground" label="Start in the background" description="Open only the tray icon when Vesper starts; click it to show the window." />
        </SettingsGroup>
      </SettingsAdvanced>
    </div>
  )
}
