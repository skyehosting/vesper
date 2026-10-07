/**
 * Tailscale CLI (07 B3/B14, research 06 §3.3). Read-only probes: `tailscale version`, `tailscale status --json`,
 * `tailscale serve status --json`. Vesper's mapping is exactly "HTTPS 443 on this machine's ts.net name → Listener C
 * (http://127.0.0.1:<tailnetPort>)", as Serve (tailnet only) or Funnel (public Internet). Setting it up and tearing it
 * down are `mutate` commands for the injected runner; only mappings that point at Vesper's own port are ever removed,
 * so other Serve configurations of the owner stay untouched. Serve needs no admin on Windows for a proxy target
 * (research 06 §10.2). Parsers are defensive: field names follow the CLI's JSON (ipnstate.Status / ipn.ServeConfig).
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Command, CommandResult } from './runner'

export interface TailscaleProbe {
  installed: boolean
  version: string | null
  /** The daemon answered (BackendState other than NoState/Stopped). */
  running: boolean
  signedIn: boolean
  /** `machine.tailnet.ts.net` (no trailing dot). */
  dnsName: string | null
  httpsEnabled: boolean
}

export interface ServeState {
  /** HTTPS 443 proxies to http://127.0.0.1:<port>. */
  port: number | null
  funnel: boolean
}

export const NOT_INSTALLED: TailscaleProbe = { installed: false, version: null, running: false, signedIn: false, dnsName: null, httpsEnabled: false }

/** The CLI: the default install location, else PATH (execFile resolves `tailscale.exe`). */
export function findTailscale(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string {
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432]) {
    if (!base) continue
    const p = path.join(base, 'Tailscale', 'tailscale.exe')
    if (exists(p)) return p
  }
  return 'tailscale'
}

export const tsCommands = {
  version: (exe: string): Command => ({ kind: 'probe', file: exe, args: ['version'] }),
  status: (exe: string): Command => ({ kind: 'probe', file: exe, args: ['status', '--json'] }),
  serveStatus: (exe: string): Command => ({ kind: 'probe', file: exe, args: ['serve', 'status', '--json'] }),
  serveOn: (exe: string, port: number): Command => ({ kind: 'mutate', file: exe, args: ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`] }),
  funnelOn: (exe: string, port: number): Command => ({ kind: 'mutate', file: exe, args: ['funnel', '--bg', '--https=443', `http://127.0.0.1:${port}`] }),
  serveOff: (exe: string): Command => ({ kind: 'mutate', file: exe, args: ['serve', '--https=443', 'off'] }),
  funnelOff: (exe: string): Command => ({ kind: 'mutate', file: exe, args: ['funnel', '--https=443', 'off'] })
}

export function parseVersion(r: CommandResult): { installed: boolean; version: string | null } {
  if (r.error === 'ENOENT') return { installed: false, version: null }
  const first = r.stdout.split(/\r?\n/)[0]?.trim() ?? ''
  return { installed: true, version: /^\d+\.\d+/.test(first) ? first : null }
}

export function parseStatus(r: CommandResult): Pick<TailscaleProbe, 'running' | 'signedIn' | 'dnsName' | 'httpsEnabled'> {
  const none = { running: false, signedIn: false, dnsName: null, httpsEnabled: false }
  if (r.error || !r.stdout.trim()) return none
  let o: { BackendState?: unknown; Self?: { DNSName?: unknown }; CertDomains?: unknown }
  try {
    o = JSON.parse(r.stdout) as typeof o
  } catch {
    return none
  }
  const state = typeof o.BackendState === 'string' ? o.BackendState : ''
  const running = state !== '' && state !== 'NoState' && state !== 'Stopped'
  const signedIn = state === 'Running'
  const raw = typeof o.Self?.DNSName === 'string' ? o.Self.DNSName.replace(/\.$/, '').toLowerCase() : ''
  const dnsName = signedIn && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(raw) ? raw : null
  const httpsEnabled = Array.isArray(o.CertDomains) && o.CertDomains.length > 0
  return { running, signedIn, dnsName, httpsEnabled }
}

/** Where HTTPS 443 for `dnsName` proxies to, and whether Funnel is on for it. */
export function parseServeStatus(r: CommandResult, dnsName: string | null): ServeState {
  const none: ServeState = { port: null, funnel: false }
  if (r.error || r.code !== 0 || !r.stdout.trim()) return none
  let o: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: unknown }> }>; AllowFunnel?: Record<string, unknown> }
  try {
    o = JSON.parse(r.stdout) as typeof o
  } catch {
    return none
  }
  for (const [hostPort, web] of Object.entries(o.Web ?? {})) {
    const [host, port] = hostPort.toLowerCase().split(/:(?=\d+$)/)
    if (port !== '443' || (dnsName && host !== dnsName)) continue
    const proxy = web?.Handlers?.['/']?.Proxy
    const m = typeof proxy === 'string' ? /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/?$/.exec(proxy) : null
    if (!m) continue
    return { port: Number(m[1]), funnel: o.AllowFunnel?.[hostPort] === true }
  }
  return none
}

/** Tailscale prints a login.tailscale.com link when Funnel/HTTPS must be approved in the admin console first. */
export function consentUrl(r: CommandResult): string | null {
  const m = /https:\/\/login\.tailscale\.com\/[^\s"']+/.exec(`${r.stdout}\n${r.stderr}`)
  return m ? m[0] : null
}

/**
 * Commands that move the mapping from `current` to `desired` (null = no Vesper mapping). Funnel and Serve share the
 * 443 handler: turning the old one off first keeps the switch deterministic.
 */
export function transition(exe: string, current: ServeState, ourPorts: number[], desired: { port: number; funnel: boolean } | null): Command[] {
  const ours = current.port !== null && ourPorts.includes(current.port)
  if (desired && ours && current.port === desired.port && current.funnel === desired.funnel) return []
  const out: Command[] = []
  if (ours) {
    if (current.funnel) out.push(tsCommands.funnelOff(exe))
    out.push(tsCommands.serveOff(exe))
  }
  if (desired) out.push(desired.funnel ? tsCommands.funnelOn(exe, desired.port) : tsCommands.serveOn(exe, desired.port))
  return out
}
