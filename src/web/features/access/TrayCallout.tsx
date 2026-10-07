/**
 * "Closing the window quits Vesper" (fix5-ui P29): with Local network or Tailscale on and "Keep running in the tray"
 * off (the default), closing Vesper's window ends the app and every phone loses access. Settings → Access and the
 * wizard's Access step say so where the choice is made, with the switch right there. Desktop only (it is the PC's
 * setting). Once turned on here the callout stays, confirming it, until the page is left. The switch has the same name
 * as the This PC card's and General's (CLOSE_TO_TRAY_LABEL): one setting, one name.
 */
import { useState, type ReactNode } from 'react'
import { Callout } from '../../components/Callout'
import { Switch } from '../../components/Switch'
import { toast } from '../../components/Toast'
import { toApiError } from '../../lib/errors.logic'
import { CLOSE_TO_TRAY_LABEL } from '../settings/catalog.logic'
import { useStore } from '../../lib/store'
import { patchSettings } from './data'

export function TrayCallout(): ReactNode {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const closeToTray = useStore((s) => s.settings?.desktop.closeToTray)
  const [turnedOnHere, setTurnedOnHere] = useState(false)
  const [saving, setSaving] = useState(false)
  if (!desktop || closeToTray === undefined || (closeToTray && !turnedOnHere)) return null

  const set = async (v: boolean): Promise<void> => {
    setSaving(true)
    try {
      await patchSettings({ desktop: { closeToTray: v } })
      setTurnedOnHere(true)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Callout
      tone={closeToTray ? 'success' : 'warning'}
      className="acc-tray"
      title={closeToTray ? 'Vesper keeps running in the tray' : 'Closing the window quits Vesper'}
    >
      <p>
        {closeToTray
          ? 'Closing the window leaves Vesper in the tray, so your other devices stay connected. Quitting from the tray still stops it.'
          : 'Your phone and other devices lose access as soon as the window is closed.'}
      </p>
      <div className="acc-tray__switch">
        <Switch checked={closeToTray} disabled={saving} onChange={(v) => void set(v)} label={CLOSE_TO_TRAY_LABEL} />
      </div>
    </Callout>
  )
}
