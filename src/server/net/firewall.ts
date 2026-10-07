/**
 * Windows Defender Firewall for Listener B (research 06 §3.2, 07 B2 "firewall allow" is desktop-only).
 * - Check (read-only, unelevated PowerShell): the network profile of each connection and every inbound rule for
 *   Vesper's executable. Block rules win over allow rules, so any enabled block rule means "blocked".
 * - Allow: ONE elevated command (one UAC prompt). It removes earlier "Vesper (LAN)" rules, and Vesper's block rules
 *   when there are any (Windows created them when its own prompt was cancelled), then adds TCP <lanPort> from the local
 *   subnet only, for Private (and Public / Domain when that network uses it) networks. The desktop app runs it when Local
 *   network access is turned on (07 H-v111-firewall), and the owner's "Allow in Windows Firewall…" click does too.
 * - Remove: ONE elevated command when Local network access is turned off: every inbound rule whose program is this
 *   Vesper.exe ("Vesper (LAN)" and the all-ports rules Windows' own "allow" dialog made for it).
 *   Nothing here runs unless the injected runner executes it; tests assert the exact command.
 */
import type { NetworkStatus } from '@shared/types/domain'
import { encodePowerShell, psQuote, type Command } from './runner'

export type FirewallState = NonNullable<NetworkStatus['lan']>['firewall']
export type NetProfile = NonNullable<NetworkStatus['lan']>['profile']

export interface FirewallRule {
  name: string
  action: string
  enabled: string
  profile: string
  /** LocalPort of the rule's port filter ("41731", "Any", "" when unknown). */
  port: string
}

export interface FirewallProbe {
  profiles: { alias: string; category: string }[]
  rules: FirewallRule[]
}

export const RULE_NAME = 'Vesper (LAN)'

export function firewallCheckCommand(program: string): Command {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '$p = @(Get-NetConnectionProfile | ForEach-Object { @{ alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory } })',
    `$r = @(Get-NetFirewallApplicationFilter -Program ${psQuote(program)} | Get-NetFirewallRule | Where-Object { [string]$_.Direction -eq 'Inbound' } | ForEach-Object { @{ name = [string]$_.DisplayName; action = [string]$_.Action; enabled = [string]$_.Enabled; profile = [string]$_.Profile; port = [string](@(($_ | Get-NetFirewallPortFilter).LocalPort) -join ',') } })`,
    '@{ profiles = $p; rules = $r } | ConvertTo-Json -Compress -Depth 4'
  ].join('\n')
  return { kind: 'probe', file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)] }
}

/** ConvertTo-Json writes a single object for one-element arrays; normalise. */
function arr<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[]
  return v && typeof v === 'object' ? [v as T] : []
}

export function parseFirewallProbe(stdout: string): FirewallProbe | null {
  try {
    const o = JSON.parse(stdout.trim().replace(/^﻿/, '')) as { profiles?: unknown; rules?: unknown }
    const profiles = arr<{ alias?: unknown; category?: unknown }>(o.profiles).map((p) => ({ alias: String(p.alias ?? ''), category: String(p.category ?? '') }))
    const rules = arr<Record<string, unknown>>(o.rules).map((r) => ({
      name: String(r.name ?? ''),
      action: String(r.action ?? ''),
      enabled: String(r.enabled ?? ''),
      profile: String(r.profile ?? ''),
      port: String(r.port ?? '')
    }))
    return { profiles, rules }
  } catch {
    return null
  }
}

function categoryToProfile(c: string): NetProfile {
  const v = c.toLowerCase()
  if (v === 'public') return 'public'
  if (v === 'private') return 'private'
  if (v.startsWith('domain')) return 'domain'
  return 'unknown'
}

/**
 * The profile that governs Listener B: the connection whose alias is the bound interface; for "all interfaces" the
 * strictest one present (Public beats Private beats Domain).
 */
export function activeProfile(probe: FirewallProbe, ifaceName: string | null): NetProfile {
  if (ifaceName) {
    const hit = probe.profiles.find((p) => p.alias.toLowerCase() === ifaceName.toLowerCase())
    if (hit) return categoryToProfile(hit.category)
  }
  const all = probe.profiles.map((p) => categoryToProfile(p.category))
  for (const p of ['public', 'private', 'domain'] as const) if (all.includes(p)) return p
  return 'unknown'
}

function ruleCovers(rule: FirewallRule, profile: NetProfile): boolean {
  const p = rule.profile.toLowerCase()
  if (p === 'any' || p === '') return true
  if (profile === 'unknown') return false
  return p.split(/[,\s]+/).includes(profile)
}

/** Vesper's own "Vesper (LAN)" rule allows `port` on `profile` (an all-ports rule Windows made for vesper.exe doesn't count). */
export function ownRuleAllows(probe: FirewallProbe, profile: NetProfile, port: number): boolean {
  return probe.rules.some(
    (r) =>
      r.name === RULE_NAME &&
      r.enabled.toLowerCase() === 'true' &&
      r.action.toLowerCase() === 'allow' &&
      ruleCovers(r, profile) &&
      r.port.split(/[,\s]+/).includes(String(port))
  )
}

export function firewallState(probe: FirewallProbe, profile: NetProfile): FirewallState {
  const enabled = probe.rules.filter((r) => r.enabled.toLowerCase() === 'true' && ruleCovers(r, profile))
  if (enabled.some((r) => r.action.toLowerCase() === 'block')) return 'blocked'
  if (enabled.some((r) => r.action.toLowerCase() === 'allow')) return 'allowed'
  return 'unknown'
}

function cmdQuote(s: string): string {
  // Windows paths can't contain '"'; refuse anything that could break out of the quoted argument.
  if (/["\r\n%]/.test(s)) throw new Error('unsafe path for netsh')
  return `"${s}"`
}

export interface AllowOptions {
  program: string
  port: number
  publicToo: boolean
  /** Also the Domain profile (the active network is a domain network). */
  domainToo?: boolean
  removeBlocks: boolean
}

/** The netsh lines the elevated shell runs, in order (exact strings asserted by tests). */
export function firewallAllowLines(o: AllowOptions): string[] {
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('bad port')
  const prog = cmdQuote(o.program)
  const profiles = ['private', ...(o.publicToo ? ['public'] : []), ...(o.domainToo ? ['domain'] : [])].join(',')
  const lines: string[] = []
  if (o.removeBlocks) lines.push(removeAllLine(prog))
  lines.push(`netsh advfirewall firewall delete rule name="${RULE_NAME}"`)
  lines.push(`netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow program=${prog} protocol=TCP localport=${o.port} remoteip=localsubnet profile=${profiles} enable=yes`)
  return lines
}

/** Every inbound rule of exactly this program (Vesper's own and the ones Windows' dialog made); other programs' stay. */
const removeAllLine = (prog: string) => `netsh advfirewall firewall delete rule name=all program=${prog} dir=in`

/** Turning Local network access off: the netsh lines (one) that remove Vesper's inbound rules. */
export function firewallRemoveLines(program: string): string[] {
  return [removeAllLine(cmdQuote(program))]
}

export function firewallAllowCommand(o: AllowOptions): Command {
  return elevatedNetsh(firewallAllowLines(o))
}

export function firewallRemoveCommand(program: string): Command {
  return elevatedNetsh(firewallRemoveLines(program))
}

/**
 * One UAC prompt: PowerShell starts an elevated, hidden cmd.exe that runs the netsh lines (`&` keeps going after the
 * "no rule matched" of a delete) and exits with netsh's last code. Cancelling UAC makes Start-Process throw → exit 1.
 */
function elevatedNetsh(lines: string[]): Command {
  const cmdline = `/d /c ${lines.join(' & ')}`
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList ${psQuote(cmdline)} -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    'exit $p.ExitCode'
  ].join('\n')
  return { kind: 'elevate', file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)] }
}

/** Decode an -EncodedCommand argument (tests and logs). */
export function decodePowerShell(cmd: Command): string {
  const i = cmd.args.indexOf('-EncodedCommand')
  return i >= 0 ? Buffer.from(cmd.args[i + 1], 'base64').toString('utf16le') : ''
}
