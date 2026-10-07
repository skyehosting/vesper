/**
 * Settings → Presence & appearance: theme, accent, motion, message size, and the Star (07 D4/D5: style, quality,
 * frame-rate cap, rest when unfocused, show behind the chat; v1.1.3: visibility and size behind the chat, with a live
 * preview — the one presence surface moves into it). presence reads these from the store.
 */
import type { ReactNode } from 'react'
import { AvatarPreview } from '../../presence'
import { AccentSetting, StarStyleSetting, ThemeSetting } from '../fields'
import type { SettingsSectionProps } from '../sections'
import { ReadOnlyNotice, SegmentedSetting, SettingsAdvanced, SettingsGroup, SettingsPageHeader, SliderSetting, SwitchSetting } from '../ui'

const PATHS = ['appearance.theme', 'chat.fontSize']

const percent = (v: number): string => `${Math.round(v * 100)} %`

export default function SettingsAppearance({ advanced }: SettingsSectionProps): ReactNode {
  return (
    <div className="spage">
      <SettingsPageHeader title="Presence & appearance" description="How Vesper looks, and how its Star behaves." />
      <ReadOnlyNotice paths={PATHS} />

      <SettingsGroup title="Look">
        <ThemeSetting />
        <AccentSetting />
        <SliderSetting setting="chat.fontSize" label="Message text size" step={1} format={(v) => `${v} px`} hint="Applies to messages; the rest of Vesper keeps its size." />
        <SwitchSetting setting="appearance.reduceMotion" label="Reduce motion" description="Fades and slides become instant; the Star breathes slowly and revealed text appears word by word." />
      </SettingsGroup>

      <SettingsGroup title="The Star" description="Vesper's presence: it listens, thinks and speaks with you.">
        <AvatarPreview />
        <SliderSetting
          setting="appearance.star.visibility"
          label="Avatar visibility"
          step={0.05}
          format={percent}
          hint="How strongly the avatar shows behind your messages; 100 % is the standard look. Very high values make the text over it harder to read (message text always stays at least 4.5 : 1)."
        />
        <SliderSetting setting="appearance.star.size" label="Avatar size" step={0.05} format={percent} hint="Its size behind the chat, from 80 % to 120 %." />
        <StarStyleSetting />
        <SwitchSetting setting="appearance.star.showInChat" label="Show the avatar behind the chat" description="Off keeps it in Talk mode only. The chat’s top bar can also hide it on this device." />
        <SwitchSetting setting="appearance.star.pauseWhenUnfocused" label="Rest when Vesper isn't focused" description="The Star stops drawing while you use other apps, unless it is speaking or listening." />
      </SettingsGroup>

      <SettingsAdvanced open={advanced}>
        <SettingsGroup title="Star rendering">
          <SegmentedSetting
            setting="appearance.star.quality"
            label="Quality"
            description="Lower quality uses less of your graphics card."
            options={[
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]}
          />
          <SliderSetting setting="appearance.star.maxFps" label="Frame-rate limit" step={5} format={(v) => `${v} fps`} hint="The Star never draws faster than this, and rests at 0 fps when idle." />
        </SettingsGroup>
      </SettingsAdvanced>
    </div>
  )
}
