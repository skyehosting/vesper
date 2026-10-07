/** Settings → Chat: the history window (R5, 07 D1), sending, titles, reasoning, recaps (07 C4), notifications. */
import type { ReactNode } from 'react'
import { EyeOff } from 'lucide-react'
import { Callout } from '../../../components/Callout'
import type { SettingsSectionProps } from '../sections'
import { TEMPORARY_CHAT_TEXT } from '../../sessions/temporaryChat.logic'
import { NumberSetting, ReadOnlyNotice, SegmentedSetting, SettingsAdvanced, SettingsGroup, SettingsPageHeader, SliderSetting, SwitchSetting } from '../ui'

const PATHS = ['chat.pageSize', 'chat.sendOnEnter', 'chat.autoTitle', 'chat.showReasoning', 'chat.notifyWhenHidden', 'chat.notificationPreviews', 'chat.loadRemoteImages']

const pct = (v: number): string => `${Math.round(v * 100)} %`

export default function SettingsChat({ advanced }: SettingsSectionProps): ReactNode {
  return (
    <div className="spage">
      <SettingsPageHeader title="Chat" description="How conversations load, send and get their titles." />
      <ReadOnlyNotice paths={PATHS} />

      <SettingsGroup title="History" description="Every message is kept; long chats load a window at a time so a million messages stay smooth.">
        <SliderSetting
          setting="chat.pageSize"
          label="Messages per page"
          hint="Vesper keeps about 3 pages in view and unloads the rest as you scroll."
          step={10}
          format={(v) => `${v} messages`}
          marks={[{ value: 20, label: '20' }, { value: 100, label: '100' }, { value: 300, label: '300' }]}
        />
      </SettingsGroup>

      <SettingsGroup title="Writing and replies">
        <SwitchSetting setting="chat.sendOnEnter" label="Enter sends" description="Shift+Enter starts a new line. Turn off to send with Ctrl+Enter." />
        <SwitchSetting setting="chat.autoTitle" label="Name chats automatically" description="After the first exchange, the helper AI suggests a short title." />
        <SwitchSetting setting="chat.showReasoning" label="Show thinking" description="When the model shares its reasoning, show it collapsed above the reply." />
        <SegmentedSetting
          setting="chat.loadRemoteImages"
          label="Images from the web"
          description="Pictures a reply links from other sites can reveal your address to that site."
          options={[
            { value: 'ask', label: 'Ask first' },
            { value: 'never', label: 'Never load' }
          ]}
        />
      </SettingsGroup>

      <SettingsGroup title="Notifications">
        <SwitchSetting setting="chat.notifyWhenHidden" label="Notify when a reply finishes in the background" />
        <SwitchSetting setting="chat.notificationPreviews" label="Show message text in notifications" description="Off keeps replies private on a shared screen." />
      </SettingsGroup>

      <Callout tone="info" icon={<EyeOff />} title="Temporary chats">
        Start one with the ghost button next to New chat, or with <code>/temp</code>. {TEMPORARY_CHAT_TEXT}
      </Callout>

      <SettingsAdvanced open={advanced}>
        <SettingsGroup title="Long conversations" description="Recaps keep a long chat within the model's context without losing the thread.">
          <SliderSetting
            setting="chat.contextFill"
            label="Summarize earlier messages at"
            hint="When the conversation fills this share of the model's context, Vesper writes a recap in the background and continues from it."
            step={0.05}
            format={pct}
          />
          <SliderSetting setting="chat.maxToolCalls" label="Memory lookups per reply" hint="How many times the AI may search memory before answering." format={(v) => (v === 0 ? 'None' : String(v))} />
        </SettingsGroup>
        <SettingsGroup title="Attachments">
          <NumberSetting setting="chat.attachments.maxFileMb" label="Largest attachment" unit="MB" />
          <NumberSetting setting="chat.attachments.maxTextChars" label="Text read from a document" unit="characters" />
        </SettingsGroup>
        <SettingsGroup title="Accessibility">
          <SegmentedSetting
            setting="chat.announceReplies"
            label="Screen reader: announce replies"
            description="Read finished replies in full, only say a reply arrived, or stay quiet."
            options={[
              { value: 'full', label: 'Full' },
              { value: 'notice', label: 'Notice' },
              { value: 'off', label: 'Off' }
            ]}
          />
        </SettingsGroup>
      </SettingsAdvanced>
    </div>
  )
}
