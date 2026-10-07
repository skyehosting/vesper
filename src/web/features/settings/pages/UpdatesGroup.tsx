/**
 * Settings → About → Updates (H-v12-updates): this version, the updater's state (GET /api/system/update on connect,
 * then `update.state`), Check now, how often Vesper checks, what it does with a new version, the download's progress
 * and "Restart to update". Check now, Download and Restart are the desktop app's; other devices see the state, and
 * the two settings read-only (desktop-only, like every setting outside REMOTE_WRITABLE_PREFIXES).
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Download, RefreshCw, RotateCw } from 'lucide-react'
import type { UpdateStatus } from '@shared/api'
import { UPDATE_INTERVALS, type UpdateMode } from '@shared/settings'
import { INTERVAL_LABELS, updateStatusText } from '@shared/updater.logic'
import { Button } from '../../../components/Button'
import { ProgressBar } from '../../../components/Progress'
import { toast } from '../../../components/Toast'
import { api } from '../../../lib/api'
import { toApiError } from '../../../lib/errors.logic'
import { useStore } from '../../../lib/store'
import { ExternalLink, SegmentedSetting, SelectSetting, SettingRow, SettingsGroup } from '../ui'

const INTERVAL_OPTIONS = UPDATE_INTERVALS.map((v) => ({ value: v, label: INTERVAL_LABELS[v] }))

const MODE_OPTIONS = [
  { value: 'install-on-close', label: 'When I close Vesper' },
  { value: 'ask', label: 'Ask first' },
  { value: 'auto', label: 'Automatically' }
] as const

const MODE_HELP: Record<UpdateMode, string> = {
  'install-on-close': 'Downloads quietly and installs the next time Vesper closes.',
  ask: 'Tells you about a new version; nothing downloads until you choose Download.',
  auto: "Downloads quietly and restarts by itself while you're away — never during a reply, a voice chat or a game."
}

type Busy = 'check' | 'download' | 'restart' | null

export function UpdatesGroup(): ReactNode {
  const status = useStore((s) => s.ui.update)
  const setUpdate = useStore((s) => s.setUpdate)
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const version = useStore((s) => s.bootstrap?.version ?? '—')
  const prefs = useStore((s) => s.settings?.updates)
  const [busy, setBusy] = useState<Busy>(null)
  const [now, setNow] = useState(() => Date.now())
  // "Checked 5 minutes ago" stays about right while the page is open.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  const checkEvery = prefs?.checkEvery ?? '1h'
  const mode = prefs?.mode ?? 'install-on-close'
  const state = status?.state ?? null
  const supported = state !== null && state !== 'unsupported'
  const portable = !!status?.portable
  const v = status?.version ?? ''

  const run = async (what: Exclude<Busy, null>, call: () => Promise<UpdateStatus | void>): Promise<void> => {
    setBusy(what)
    try {
      const r = await call()
      if (r) setUpdate(r)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsGroup id="updates" title="Updates" description="New versions come from Vesper's releases on GitHub.">
      <SettingRow inline>
        <div className="set-row__text">
          <span className="set-row__label">
            Version <span className="tabular">{version}</span>
          </span>
          <span className="set-row__desc" role="status" data-testid="update-status">
            {status ? updateStatusText(status, { checkEvery, mode, now }) : ''}
          </span>
          {status?.error && status.state === 'available' ? <span className="set-row__desc">{status.error}</span> : null}
        </div>
        {desktop && supported ? (
          <Button
            icon={<RefreshCw />}
            loading={busy === 'check' || state === 'checking'}
            disabled={state === 'downloading' || state === 'ready'}
            onClick={() => void run('check', () => api('POST /api/system/update/check'))}
          >
            Check now
          </Button>
        ) : null}
      </SettingRow>

      {state === 'downloading' ? (
        <SettingRow>
          <ProgressBar label={`Downloading version ${v}`} value={(status?.percent ?? 0) / 100} />
        </SettingRow>
      ) : null}

      {state === 'available' && (portable || !desktop) && status?.releaseUrl ? (
        <SettingRow inline>
          <div className="set-row__text">
            <span className="set-row__label">What's new in {v}</span>
          </div>
          <ExternalLink href={status.releaseUrl}>Open the release page</ExternalLink>
        </SettingRow>
      ) : null}

      {desktop && state === 'available' && !portable && mode === 'ask' ? (
        <SettingRow inline>
          <div className="set-row__text">
            <span className="set-row__label">Download version {v}</span>
            <span className="set-row__desc">Only the parts that changed are downloaded when possible.</span>
          </div>
          <Button icon={<Download />} loading={busy === 'download'} onClick={() => void run('download', () => api('POST /api/system/update/download'))}>
            Download
          </Button>
        </SettingRow>
      ) : null}

      {desktop && state === 'ready' ? (
        <SettingRow inline>
          <div className="set-row__text">
            <span className="set-row__label">Install version {v} now</span>
            <span className="set-row__desc">Vesper closes, updates and opens again in a few seconds.</span>
          </div>
          <Button variant="primary" icon={<RotateCw />} loading={busy === 'restart'} onClick={() => void run('restart', () => api('POST /api/system/update/restart'))}>
            Restart to update
          </Button>
        </SettingRow>
      ) : null}

      <SelectSetting setting="updates.checkEvery" label="Check for updates" hint="Each check is one small request to GitHub." options={INTERVAL_OPTIONS} />
      {portable ? null : <SegmentedSetting setting="updates.mode" label="When a new version is out" description={MODE_HELP[mode]} options={MODE_OPTIONS} />}
    </SettingsGroup>
  )
}
