/**
 * This PC (desktop only): both addresses — http://vesper.localhost:<port> for browsers on this PC, and the Local network
 * address other devices type (the LAN panel's, 07 H-v111-firewall) or why there is none — then "Open in browser": a
 * browser on this PC signs in through a one-time local pairing code (07 B4; no approval needed, the code never leaves
 * this PC) — plus Start with Windows (installed build only, 07 E8; starts in the tray) and Close to tray.
 */
import { useState, type ReactNode } from 'react'
import { ExternalLink, Monitor } from 'lucide-react'
import type { NetworkStatus } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { CopyButton } from '../../components/CopyButton'
import { Switch } from '../../components/Switch'
import { toast } from '../../components/Toast'
import { toApiError } from '../../lib/errors.logic'
import { CLOSE_TO_TRAY_LABEL } from '../settings/catalog.logic'
import { useStore } from '../../lib/store'
import { lanAddressForOthers } from './access.logic'
import { createPairing, patchSettings } from './data'
import { openExternal } from './links'

export function ThisPcCard({ network }: { network: NetworkStatus | null }): ReactNode {
  const desktopSettings = useStore((s) => s.settings?.desktop)
  const portable = useStore((s) => s.bootstrap?.portable ?? false)
  const [opening, setOpening] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)

  const openInBrowser = async (): Promise<void> => {
    setOpening(true)
    try {
      const r = await createPairing('local')
      openExternal(r.url)
      toast.info('Opening Vesper in your browser…', { durationMs: 3000 })
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setOpening(false)
    }
  }

  const set = async (key: 'startWithWindows' | 'closeToTray', v: boolean): Promise<void> => {
    setSaving(key)
    try {
      await patchSettings({ desktop: { [key]: v } })
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setSaving(null)
    }
  }

  return (
    <Card as="section" className="acc-panel" icon={<Monitor />} title="This PC" description={network ? `Browsers on this PC use ${network.loopback.browserUrl}` : undefined}>
      {network ? <OtherDevices network={network} /> : null}
      <div className="acc-row">
        <div className="acc-row__text">
          <span className="acc-row__title">Open Vesper in your browser</span>
          <span className="acc-muted">Signs that browser in with a one-time link. Nothing is opened to the network.</span>
        </div>
        <Button icon={<ExternalLink />} loading={opening} onClick={() => void openInBrowser()}>
          Open in browser
        </Button>
      </div>
      {desktopSettings ? (
        <div className="acc-switches">
          {portable ? null : (
            <Switch
              checked={desktopSettings.startWithWindows}
              onChange={(v) => void set('startWithWindows', v)}
              disabled={saving === 'startWithWindows'}
              label="Start with Windows"
              description="Vesper starts quietly in the tray when you sign in to Windows."
            />
          )}
          <Switch
            checked={desktopSettings.closeToTray}
            onChange={(v) => void set('closeToTray', v)}
            disabled={saving === 'closeToTray'}
            label={CLOSE_TO_TRAY_LABEL}
            description="Phones and other devices can keep using Vesper while the window is closed."
          />
          {portable ? <p className="acc-muted">Start with Windows needs the installed version of Vesper.</p> : null}
        </div>
      ) : null}
    </Card>
  )
}

/** The second address: what phones and computers on the same network type, or how to turn that on. */
function OtherDevices({ network }: { network: NetworkStatus }): ReactNode {
  const addr = lanAddressForOthers(network)
  if (addr) {
    return (
      <div className="acc-others" data-testid="acc-others">
        <span>Phones and computers on your network:</span>{' '}
        <span className="acc-mono">{addr}</span>
        <CopyButton text={addr} label={`Copy ${addr}`} size="sm" />
      </div>
    )
  }
  // Choosing the Local network card opens the apply bar, which says what Windows will ask.
  const choose = (): void => {
    const radio = document.querySelector<HTMLInputElement>('[data-setting="access.mode"] input[type="radio"][value="lan"]')
    const card = radio?.closest('label') ?? radio
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    radio?.click()
    radio?.focus({ preventScroll: true })
  }
  return (
    <div className="acc-others" data-testid="acc-others">
      <span>Other devices can’t reach Vesper until Local network access is on.</span>
      {network.mode !== 'lan' && !network.portable ? (
        <Button size="sm" variant="ghost" onClick={choose}>
          Turn on Local network…
        </Button>
      ) : null}
    </div>
  )
}
