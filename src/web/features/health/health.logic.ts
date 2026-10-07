/**
 * SystemHealth (Bootstrap.health, then `health.changed`) → what the owner is told (fix-platform F59/F66): one notice
 * per problem, shown as a toast once (per key) and as a banner at the top of Settings while it lasts. Pure.
 */
import type { SystemHealth } from '@shared/api'
import { formatSize } from '../memory/format.logic'

export interface HealthNotice {
  /** Stable per occurrence: a toast is shown once per key. */
  key: string
  kind: 'settings' | 'lowDisk' | 'backup'
  tone: 'warning' | 'danger'
  title: string
  text: string
  /** The toast's line (P07): short — the full text, with the kept file's name, is on the Settings banner. */
  brief: string
  /** Offer "Open folder" (desktop) on the data folder. */
  folder: boolean
  /** Offer "Set up again" (the wizard). */
  setup: boolean
  /** Offer "Open Data settings". */
  data: boolean
}

function dateText(utc: number): string {
  return new Date(utc).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function healthNotices(h: SystemHealth | null | undefined): HealthNotice[] {
  if (!h) return []
  const out: HealthNotice[] = []
  const s = h.settingsRecovered
  if (s) {
    const kept = s.copy ? ` The original file is kept as ${s.copy} in Vesper's data folder.` : ''
    const base = { key: `settings:${s.kind}:${s.atUtc}`, kind: 'settings' as const, folder: true, data: false }
    const details = s.copy ? 'Vesper kept a copy of the old file. Details are in Settings.' : 'Details are in Settings.'
    if (s.kind === 'repaired') {
      const n = s.dropped.length
      out.push({ ...base, tone: 'warning', setup: false, title: 'Some settings were reset', brief: details, text: `${n === 1 ? 'One setting' : `${n} settings`} in settings.json ${n === 1 ? "wasn't" : "weren't"} valid and now ${n === 1 ? 'uses its default' : 'use their defaults'}.${kept}` })
    } else if (s.kind === 'restored') {
      out.push({ ...base, tone: 'warning', setup: false, title: 'Your settings were restored', brief: details, text: `settings.json couldn't be read, so Vesper put back the settings it saved last.${kept}` })
    } else {
      out.push({
        ...base,
        tone: 'danger',
        setup: true,
        title: "Your settings couldn't be read",
        brief: `Vesper is using its default settings for now. ${details}`,
        text: `settings.json is damaged and there was no saved copy, so Vesper is using its default settings for now.${kept} Fix the file and restart Vesper, or set Vesper up again.`
      })
    }
  }
  if (h.lowDisk) {
    out.push({
      key: `lowDisk:${h.lowDisk.sinceUtc}`,
      kind: 'lowDisk',
      tone: 'warning',
      title: 'Your disk is almost full',
      text: `Only ${formatSize(h.lowDisk.freeBytes)} is free. Vesper paused backups and memory indexing until there is more free space.`,
      brief: `Only ${formatSize(h.lowDisk.freeBytes)} is free. Backups and memory indexing are paused.`,
      folder: false,
      setup: false,
      data: true
    })
  }
  const b = h.lastBackupError
  if (b) {
    out.push({
      key: `backup:${b.code}:${new Date(b.atUtc).toDateString()}`,
      kind: 'backup',
      tone: 'danger',
      title: b.kind === 'daily' ? 'The daily backup failed' : 'The last backup failed',
      text: `${b.message} (${dateText(b.atUtc)})`,
      brief: b.message,
      folder: false,
      setup: false,
      data: true
    })
  }
  return out
}

/** Settings shows every notice as a banner at the top: a toast there would say the same thing twice (P07). */
export function onSettingsPage(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/')
}

/** Which notices to toast now: those not toasted before (the set is updated). */
export function freshNotices(list: HealthNotice[], seen: Set<string>): HealthNotice[] {
  const out = list.filter((n) => !seen.has(n.key))
  for (const n of out) seen.add(n.key)
  return out
}
