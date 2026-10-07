/**
 * Pure helpers for the access pages (R1; 07 B14–B16, D8): the capability matrix per mode, warning tones, fingerprint
 * and countdown formatting, audit-log labels. No DOM, no React (unit-tested, and typechecked by the node project too).
 */
import type { AccessMode, DeviceInfo, NetworkStatus, NetworkWarningCode } from '@shared/types/domain'

// ── modes and the capability matrix (07 D8) ──────────────────────────────────────────────────

export interface ModeInfo {
  id: AccessMode
  title: string
  /** Column header in the narrow capability matrix. */
  short: string
  /** One line under the title. */
  summary: string
  /** What it takes. */
  needs: string
}

export const MODES: readonly ModeInfo[] = [
  { id: 'local', title: 'This PC only', short: 'This PC', summary: 'The app and browsers on this PC. Nothing is reachable from the network.', needs: 'Nothing to set up' },
  { id: 'lan', title: 'Local network', short: 'Local', summary: 'Phones and laptops on your Wi‑Fi open Vesper in their browser.', needs: 'A password · each device accepts the certificate once' },
  { id: 'tailscale', title: 'Anywhere, with Tailscale', short: 'Tailscale', summary: 'Your own devices, from anywhere, through your private Tailscale network.', needs: 'A password · Tailscale on this PC and each device' }
]

export function modeInfo(mode: AccessMode): ModeInfo {
  return MODES.find((m) => m.id === mode) ?? MODES[0]
}

/** yes · no · not applicable (the row doesn't concern that mode) */
export type Cap = 'yes' | 'no' | 'na'

export interface CapabilityRow {
  id: string
  label: string
  cells: Record<AccessMode, { cap: Cap; note?: string }>
}

/**
 * What works where (07 D8): LAN uses a self-signed certificate, so phones warn once, the mic works after accepting it
 * (secure context) but the app can't be installed; Tailscale has a trusted certificate, so everything works.
 */
export const CAPABILITIES: readonly CapabilityRow[] = [
  {
    id: 'pc',
    label: 'Browsers on this PC',
    cells: { local: { cap: 'yes' }, lan: { cap: 'yes' }, tailscale: { cap: 'yes' } }
  },
  {
    id: 'home',
    label: 'Phones and laptops at home',
    cells: { local: { cap: 'no' }, lan: { cap: 'yes', note: 'Same Wi‑Fi' }, tailscale: { cap: 'yes', note: 'With the Tailscale app' } }
  },
  {
    id: 'away',
    label: 'Away from home',
    cells: { local: { cap: 'no' }, lan: { cap: 'no' }, tailscale: { cap: 'yes', note: 'With the Tailscale app' } }
  },
  {
    id: 'mic',
    label: 'Microphone on phones',
    cells: { local: { cap: 'na' }, lan: { cap: 'yes', note: 'After accepting the certificate' }, tailscale: { cap: 'yes' } }
  },
  {
    id: 'install',
    label: 'Add to home screen as an app',
    cells: { local: { cap: 'na' }, lan: { cap: 'no', note: 'Opens in the browser' }, tailscale: { cap: 'yes' } }
  },
  {
    id: 'cert',
    label: 'No certificate warning',
    cells: { local: { cap: 'yes' }, lan: { cap: 'no', note: 'Warns once per device' }, tailscale: { cap: 'yes' } }
  }
]

export function capText(cap: Cap): string {
  return cap === 'yes' ? 'Yes' : cap === 'no' ? 'No' : 'Not needed'
}

// ── warnings ─────────────────────────────────────────────────────────────────────────────────

export type WarningTone = 'info' | 'warning' | 'danger'

const DANGER: ReadonlySet<NetworkWarningCode> = new Set<NetworkWarningCode>(['funnel_public', 'login_suspended', 'port_unavailable', 'cert_failed', 'tailscale_failed'])
const INFO: ReadonlySet<NetworkWarningCode> = new Set<NetworkWarningCode>(['remote_paused', 'portable', 'tailscale_consent'])

export function warningTone(code: NetworkWarningCode): WarningTone {
  if (DANGER.has(code)) return 'danger'
  if (INFO.has(code)) return 'info'
  return 'warning'
}

/** Warnings another part of the page already explains in place (shown there instead of in the list at the top). */
const SHOWN_IN_PLACE: ReadonlySet<NetworkWarningCode> = new Set<NetworkWarningCode>([
  'firewall_blocked',
  'firewall_unknown',
  'network_public',
  'tailscale_missing',
  'tailscale_stopped',
  'tailscale_signed_out',
  'tailscale_https_off',
  'tailscale_consent',
  'funnel_public',
  'remote_paused',
  'login_suspended',
  'password_required'
])

/** The warnings for the top-of-page list (the rest appear next to the control they concern). */
export function topWarnings(n: NetworkStatus | null): NonNullable<NetworkStatus['warnings']> {
  return (n?.warnings ?? []).filter((w) => !SHOWN_IN_PLACE.has(w.code))
}

export function hasWarning(n: NetworkStatus | null, code: NetworkWarningCode): boolean {
  return !!n?.warnings?.some((w) => w.code === code)
}

// ── addresses and the firewall prompt (07 H-v111-firewall) ───────────────────────────────────

/**
 * The address phones and other computers on the same network type — the Local network panel's first URL, e.g.
 * https://192.168.1.20:41731 — or null while Local network access isn't running. The LAN panel and the This PC card
 * show the same one.
 */
export function lanAddressForOthers(n: NetworkStatus | null): string | null {
  const lan = n?.lan
  if (!n || n.mode !== 'lan' || !lan?.running) return null
  return lan.urls?.[0] ?? lan.url ?? null
}

/**
 * What the apply bar says before a switch: the desktop app adds Vesper's firewall rule when Local network access goes
 * on and removes its rules when it goes off, each after Windows asks for permission (no rule needed on loopback).
 */
export function firewallSwitchNote(current: AccessMode, next: AccessMode, lan: NetworkStatus['lan'] | undefined): string | null {
  if (next === 'lan' && current !== 'lan') return 'Windows will ask for permission to add Vesper’s firewall rule, so devices on your network can connect.'
  if (current === 'lan' && next !== 'lan' && lan?.firewall !== 'not-needed') return 'Windows will ask for permission to remove Vesper’s firewall rules.'
  return null
}

// ── formatting ───────────────────────────────────────────────────────────────────────────────

/**
 * A SHA-256 fingerprint ("AB:CD:…", 32 bytes) as 4 lines of 8 bytes, so it can be compared with the browser's
 * certificate viewer at a glance. Anything else is returned as one line.
 */
export function fingerprintLines(fp: string | null | undefined): string[] {
  if (!fp) return []
  const bytes = fp
    .trim()
    .toUpperCase()
    .split(/[:\s]+/)
    .filter(Boolean)
  if (bytes.length < 2 || !bytes.every((b) => /^[0-9A-F]{2}$/.test(b))) return [fp]
  const lines: string[] = []
  for (let i = 0; i < bytes.length; i += 8) lines.push(bytes.slice(i, i + 8).join(':'))
  return lines
}

/** "4:05" / "0:09" for a countdown; never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** "4 minutes 5 seconds" for screen readers (the visible text is the m:ss form). */
export function countdownWords(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  const parts: string[] = []
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (s || !m) parts.push(`${s} second${s === 1 ? '' : 's'}`)
  return parts.join(' ')
}

/** Group a pairing code for reading aloud / typing: "k3f9 x2a1 …". */
export function groupCode(code: string, size = 4): string {
  const out: string[] = []
  for (let i = 0; i < code.length; i += size) out.push(code.slice(i, i + size))
  return out.join(' ')
}

// ── devices ──────────────────────────────────────────────────────────────────────────────────

export function listenerLabel(l: DeviceInfo['listener']): string {
  return l === 'loopback' ? 'This PC' : l === 'lan' ? 'Local network' : 'Tailscale'
}

export function kindLabel(k: DeviceInfo['kind']): string {
  return k === 'desktop' ? 'Vesper app' : k === 'paired' ? 'Paired' : 'Password'
}

/** Kind of icon for a device row, from its user agent (never trusted for anything but the picture). */
export function deviceIcon(d: Pick<DeviceInfo, 'kind' | 'userAgent'>): 'desktop' | 'phone' | 'tablet' | 'laptop' {
  if (d.kind === 'desktop') return 'desktop'
  const ua = d.userAgent ?? ''
  if (/iPad|Tablet/i.test(ua)) return 'tablet'
  if (/Android|iPhone|iPod|Mobile/i.test(ua)) return 'phone'
  return 'laptop'
}

/** Current device first, then pending, then the most recently seen. */
export function sortDevices(list: readonly DeviceInfo[]): DeviceInfo[] {
  const seen = (d: DeviceInfo) => d.lastSeenUtc ?? d.createdUtc
  return [...list].sort((a, b) => Number(b.current) - Number(a.current) || Number(b.pending) - Number(a.pending) || seen(b) - seen(a))
}

// ── audit log ────────────────────────────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  'login.ok': 'Signed in with the password',
  'login.fail': 'Wrong password',
  'login.suspended': 'Sign-in from other devices paused (too many wrong passwords)',
  'login.resumed': 'Sign-in from other devices resumed',
  logout: 'Signed out',
  'sudo.ok': 'Password confirmed',
  'sudo.fail': 'Wrong password (confirmation)',
  'password.set': 'Password set',
  'password.change': 'Password changed',
  'password.fail': 'Wrong current password',
  'pair.create': 'Pairing code created',
  'pair.redeem': 'Pairing code used',
  'pair.fail': 'Invalid pairing code',
  'device.approve': 'Device allowed',
  'device.deny': 'Device denied',
  'device.expired': 'Device request expired',
  'device.revoke': 'Device signed out',
  'network.change': 'Access settings changed',
  'network.pause': 'Remote access paused',
  'network.resume': 'Remote access resumed',
  'firewall.allow': 'Windows Firewall rule requested',
  'firewall.remove': 'Windows Firewall rules removal requested',
  'funnel.auto_off': 'Funnel turned off automatically'
}

export function auditLabel(event: string): string {
  return EVENT_LABELS[event] ?? event.replace(/[._]/g, ' ')
}

export type AuditTone = 'neutral' | 'success' | 'warning' | 'danger'

export function auditTone(event: string): AuditTone {
  if (/fail|suspended|deny/.test(event)) return 'danger'
  if (/revoke|expired|pause|firewall/.test(event)) return 'warning'
  if (/\.ok$|approve|set$|resumed|resume$/.test(event)) return 'success'
  return 'neutral'
}

/** A short, safe summary of an audit entry's JSON detail (device name, listener, target), never raw JSON. */
export function auditDetail(detail: string | null): string {
  if (!detail) return ''
  let d: unknown
  try {
    d = JSON.parse(detail)
  } catch {
    return ''
  }
  if (!d || typeof d !== 'object') return ''
  const o = d as Record<string, unknown>
  const parts: string[] = []
  if (typeof o.name === 'string' && o.name) parts.push(`“${o.name}”`)
  if (o.listener === 'loopback' || o.listener === 'lan' || o.listener === 'tailnet') parts.push(listenerLabel(o.listener))
  if (o.target === 'local' || o.target === 'lan' || o.target === 'tailnet') parts.push(`for ${o.target === 'local' ? 'this PC' : o.target === 'lan' ? 'the local network' : 'Tailscale'}`)
  if (typeof o.mode === 'string') parts.push(`mode: ${modeInfo(o.mode as AccessMode).title}`)
  if (typeof o.ok === 'boolean' && !o.ok) parts.push('cancelled or failed')
  return parts.join(' · ')
}

// ── funnel ───────────────────────────────────────────────────────────────────────────────────

export const FUNNEL_HOURS: readonly { value: string; label: string }[] = [
  { value: '1', label: 'After 1 hour' },
  { value: '2', label: 'After 2 hours' },
  { value: '4', label: 'After 4 hours' },
  { value: '8', label: 'After 8 hours' },
  { value: '24', label: 'After 24 hours' },
  { value: '72', label: 'After 3 days' },
  { value: '0', label: 'Never (not recommended)' }
]
