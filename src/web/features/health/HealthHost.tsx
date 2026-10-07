/**
 * App-level SystemHealth wiring (fix-platform F59/F66), mounted once while the app is ready (App.tsx):
 *  - `health.changed` → bootstrap.health in the store (the Settings banners read it live);
 *  - on the PC, a toast once per problem (settings recovered, low disk, a failed backup) with a way to act on it —
 *    except on Settings, whose top shows the same notice (fix5-ui P07: one notice, not two). Opening Settings while
 *    such a toast is up closes it. The toast says the short version; the banner has the details.
 * <HealthBanners /> shows the notices at the top of Settings while they last, as callouts like the page's own (P10).
 */
import { useEffect, type ReactNode } from 'react'
import type { SystemHealth } from '@shared/api'
import { Callout } from '../../components/Callout'
import { Button } from '../../components/Button'
import { toast } from '../../components/Toast'
import { getLocation, navigate, useLocation } from '../../lib/router'
import { useStore } from '../../lib/store'
import { ws } from '../../lib/ws'
import { openFolder } from '../settings/folders'
import { freshNotices, healthNotices, onSettingsPage, type HealthNotice } from './health.logic'
import './health.css'

/** Toasted notice keys (per page load: a reload shows a lasting problem once more). */
const toasted = new Set<string>()

function setHealth(health: SystemHealth): void {
  useStore.setState((s) => (s.bootstrap ? { bootstrap: { ...s.bootstrap, health } } : {}))
}

const KINDS: HealthNotice['kind'][] = ['settings', 'lowDisk', 'backup']

function toastFresh(health: SystemHealth | undefined): void {
  if (!useStore.getState().bootstrap?.desktop) return
  const fresh = freshNotices(healthNotices(health), toasted)
  // On Settings the banners already say it; the notices count as shown.
  if (onSettingsPage(getLocation().pathname)) return
  for (const n of fresh) {
    const target = n.kind === 'settings' ? '/settings' : '/settings/data'
    toast.show(n.tone === 'danger' ? 'error' : 'warning', n.brief, {
      id: `health-${n.kind}`,
      title: n.title,
      durationMs: 12_000,
      action: { label: n.kind === 'settings' ? 'Open Settings' : 'Open Data settings', onClick: () => navigate(target) }
    })
  }
}

export function HealthHost(): ReactNode {
  const { pathname } = useLocation()
  useEffect(() => {
    toastFresh(useStore.getState().bootstrap?.health)
    return ws.on('health.changed', (m) => {
      setHealth(m.health)
      toastFresh(m.health)
    })
  }, [])
  // Arriving on Settings: its banners take over from any health toast still showing.
  useEffect(() => {
    if (onSettingsPage(pathname)) for (const k of KINDS) toast.dismiss(`health-${k}`)
  }, [pathname])
  return null
}

function NoticeBanner({ n, desktop, onData }: { n: HealthNotice; desktop: boolean; onData: boolean }): ReactNode {
  const any = (n.setup && desktop) || (n.folder && desktop) || (n.data && !onData)
  const actions = (
    <>
      {n.setup && desktop ? (
        <Button size="sm" onClick={() => navigate('/setup')}>
          Set up again
        </Button>
      ) : null}
      {n.folder && desktop ? (
        <Button size="sm" onClick={() => void openFolder('roaming')}>
          Open folder
        </Button>
      ) : null}
      {n.data && !onData ? (
        <Button size="sm" onClick={() => navigate('/settings/data')}>
          Data settings
        </Button>
      ) : null}
    </>
  )
  return (
    <Callout tone={n.tone} className="settings__health" title={n.title} actions={any ? actions : undefined}>
      {n.text}
    </Callout>
  )
}

/** The current health notices as banners (top of Settings). */
export function HealthBanners({ only, section }: { only?: HealthNotice['kind'][]; section?: string }): ReactNode {
  const health = useStore((s) => s.bootstrap?.health)
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const list = healthNotices(health).filter((n) => !only || only.includes(n.kind))
  if (!list.length) return null
  return (
    <div className="health__list" data-health>
      {list.map((n) => (
        <NoticeBanner key={n.key} n={n} desktop={desktop} onData={section === 'data'} />
      ))}
    </div>
  )
}

/** Settings → Data, Backups: the last failed backup and low disk, right above the list (F66). */
export function BackupHealth(): ReactNode {
  const health = useStore((s) => s.bootstrap?.health)
  const list = healthNotices(health).filter((n) => n.kind === 'backup' || n.kind === 'lowDisk')
  if (!list.length) return null
  return (
    <div className="health__list" data-backup-health>
      {list.map((n) => (
        <Callout key={n.key} tone={n.tone} title={n.title}>
          {n.text}
        </Callout>
      ))}
    </div>
  )
}
