/**
 * Settings → Data (memory-ui; 07 A4, C20, D12, E8): storage use with open-folder, export, import with preview,
 * backups (schedule, list, back up now, restore + restart) and diagnostic logging. Sections live in
 * features/privacy/DataParts.tsx. Desktop-only settings are read-only on other devices (07 B2); export, import and
 * backups need a recent password there (sudo).
 */
import type { ReactNode } from 'react'
import { Disclosure } from '../../../components/Disclosure'
import { Switch } from '../../../components/Switch'
import { Group, Page, Row } from '../../memory/layout'
import { SettingSlider, SettingText } from '../../memory/controls'
import { useIsDesktop, usePatchSettings, useSettings } from '../../memory/settings'
import { BackupsList, ExportSection, ImportSection, StorageUsage } from '../../privacy/DataParts'
import { BackupHealth } from '../../health/HealthHost'
import type { SettingsSectionProps } from '../sections'
import '../../memory/memory.css'
import '../../privacy/privacy.css'
import '../../privacy/data.css'

export default function SettingsData({ advanced }: SettingsSectionProps): ReactNode {
  const settings = useSettings()
  const desktop = useIsDesktop()
  const patch = usePatchSettings()
  if (!settings) return null
  const d = settings.data
  const readOnly = !desktop

  const diagnostics = (
    <Row setting="data.diagnosticLogging">
      <Switch
        checked={d.diagnosticLogging}
        disabled={readOnly}
        onChange={(v) => void patch({ data: { diagnosticLogging: v } })}
        label="Diagnostic logging"
        description="Adds message text to the local log files to help find a problem. Turns itself off after 24 hours. Logs never leave this PC."
      />
    </Row>
  )

  return (
    <Page title="Data" description="Everything Vesper keeps is on this PC. Take it with you, bring in chats from elsewhere, and keep backups.">
      <Group id="data-storage" title="Storage">
        <Row>
          <StorageUsage desktop={desktop} />
        </Row>
      </Group>

      <Group
        id="data-export"
        title="Export"
        description="Exports never include the hidden wire transcript, deleted messages or temporary chats."
      >
        <ExportSection />
      </Group>

      <Group id="data-import" title="Import past chats" description="From ChatGPT, Claude or another Vesper.">
        <ImportSection memoryOn={settings.memory.enabled} />
      </Group>

      <Group id="data-backups" title="Backups">
        <Row setting="data.backups">
          <Switch
            checked={d.backups}
            disabled={readOnly}
            onChange={(v) => void patch({ data: { backups: v } })}
            label="Back up every day"
            description="When the PC is idle, and always before an update changes the database."
          />
        </Row>
        {d.backups ? (
          <>
            <Row setting="data.backupDaily" stack>
              <SettingSlider
                label="Daily backups to keep"
                value={d.backupDaily}
                min={1}
                max={30}
                disabled={readOnly}
                onSave={(v) => patch({ data: { backupDaily: v } })}
              />
            </Row>
            <Row setting="data.backupWeekly" stack>
              <SettingSlider
                label="Weekly backups to keep"
                value={d.backupWeekly}
                min={0}
                max={52}
                disabled={readOnly}
                onSave={(v) => patch({ data: { backupWeekly: v } })}
              />
            </Row>
          </>
        ) : null}
        <Row setting="data.backupExtraDir" stack>
          <SettingText
            label="Also copy backups to"
            hint="Optional: a folder on another drive or a synced folder (for example OneDrive). Leave empty for none."
            placeholder="D:\Backups\Vesper"
            value={d.backupExtraDir}
            mono
            disabled={readOnly}
            onSave={(v) => patch({ data: { backupExtraDir: v } })}
          />
        </Row>
        <BackupHealth />
        <BackupsList desktop={desktop} />
      </Group>

      {advanced ? (
        <Group id="data-advanced" title="Advanced">
          {diagnostics}
        </Group>
      ) : (
        <Disclosure summary="Advanced" variant="card" headingLevel={3} className="mem-advanced">
          <div className="mem-advanced__body">{diagnostics}</div>
        </Disclosure>
      )}
    </Page>
  )
}
