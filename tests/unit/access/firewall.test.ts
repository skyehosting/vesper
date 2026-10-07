/**
 * Windows Firewall check + user-initiated allow (research 06 §3.2): exact commands that WOULD run (never executed:
 * a fake runner answers), parsing and the decision table, and the desktop-only route. @R1
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  activeProfile,
  decodePowerShell,
  firewallAllowCommand,
  firewallAllowLines,
  firewallCheckCommand,
  firewallRemoveCommand,
  firewallRemoveLines,
  firewallState,
  ownRuleAllows,
  parseFirewallProbe
} from '@server/net/firewall'
import { FakeRunner } from './fakeRunner'
import { startAccessServer, type AccessServer } from './helpers'

const EXE = 'C:\\Users\\Raven\\AppData\\Local\\Programs\\Vesper\\Vesper.exe'

describe('commands', () => {
  it('the check is a read-only, unelevated PowerShell probe of profiles and Vesper’s inbound rules', () => {
    const c = firewallCheckCommand("C:\\Users\\O'Neil\\Vesper.exe")
    expect(c.kind).toBe('probe')
    expect(c.file).toBe('powershell.exe')
    expect(c.args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    const script = decodePowerShell(c)
    expect(script).toContain('Get-NetConnectionProfile')
    expect(script).toContain("Get-NetFirewallApplicationFilter -Program 'C:\\Users\\O''Neil\\Vesper.exe'")
    expect(script).toContain("port = [string](@(($_ | Get-NetFirewallPortFilter).LocalPort) -join ',')")
    expect(script).not.toMatch(/RunAs|netsh|Set-|New-|Remove-/)
  })

  it('allow = ONE elevated cmd: drop old Vesper rules (and block rules when blocked), add TCP <port> from the local subnet', () => {
    expect(firewallAllowLines({ program: EXE, port: 41731, publicToo: false, removeBlocks: false })).toEqual([
      'netsh advfirewall firewall delete rule name="Vesper (LAN)"',
      `netsh advfirewall firewall add rule name="Vesper (LAN)" dir=in action=allow program="${EXE}" protocol=TCP localport=41731 remoteip=localsubnet profile=private enable=yes`
    ])
    const blocked = firewallAllowLines({ program: EXE, port: 41731, publicToo: true, removeBlocks: true })
    expect(blocked[0]).toBe(`netsh advfirewall firewall delete rule name=all program="${EXE}" dir=in`)
    expect(blocked[2]).toContain('profile=private,public')

    const c = firewallAllowCommand({ program: EXE, port: 41731, publicToo: false, removeBlocks: false })
    expect(c.kind).toBe('elevate')
    const script = decodePowerShell(c)
    expect(script).toContain("Start-Process -FilePath 'cmd.exe' -ArgumentList '/d /c netsh advfirewall firewall delete rule name=\"Vesper (LAN)\" & netsh advfirewall firewall add rule")
    expect(script).toContain('-Verb RunAs -WindowStyle Hidden -Wait -PassThru')
    expect(script).toContain('exit $p.ExitCode')
    expect(() => firewallAllowLines({ program: 'C:\\x"&calc&"\\Vesper.exe', port: 41731, publicToo: false, removeBlocks: false })).toThrow()
    expect(() => firewallAllowLines({ program: 'C:\\%PATH%\\Vesper.exe', port: 41731, publicToo: false, removeBlocks: false })).toThrow()
    expect(() => firewallAllowLines({ program: EXE, port: 70000, publicToo: false, removeBlocks: false })).toThrow()
    expect(firewallAllowLines({ program: EXE, port: 41731, publicToo: false, domainToo: true, removeBlocks: false })[1]).toContain('profile=private,domain enable=yes')
  })

  it('remove (Local network access turned off) = ONE elevated cmd deleting every inbound rule of exactly this Vesper.exe', () => {
    expect(firewallRemoveLines(EXE)).toEqual([`netsh advfirewall firewall delete rule name=all program="${EXE}" dir=in`])
    const c = firewallRemoveCommand(EXE)
    expect(c.kind).toBe('elevate')
    expect(decodePowerShell(c)).toContain(`-ArgumentList '/d /c netsh advfirewall firewall delete rule name=all program="${EXE}" dir=in' -Verb RunAs -WindowStyle Hidden -Wait -PassThru`)
    expect(() => firewallRemoveLines('C:\\x"&calc&"\\Vesper.exe')).toThrow()
  })
})

describe('decision table', () => {
  const probe = (rules: { action: string; enabled?: string; profile: string }[], categories: Record<string, string> = { Ethernet: 'Public', Hamachi: 'Public' }) =>
    parseFirewallProbe(
      JSON.stringify({
        profiles: Object.entries(categories).map(([alias, category]) => ({ alias, category })),
        rules: rules.map((r) => ({ name: 'Vesper', enabled: 'True', ...r }))
      })
    )!

  it('block beats allow; an allow rule must cover the active profile; Any covers all', () => {
    expect(firewallState(probe([]), 'public')).toBe('unknown')
    expect(firewallState(probe([{ action: 'Allow', profile: 'Private' }]), 'public')).toBe('unknown')
    expect(firewallState(probe([{ action: 'Allow', profile: 'Private, Public' }]), 'public')).toBe('allowed')
    expect(firewallState(probe([{ action: 'Allow', profile: 'Any' }, { action: 'Block', profile: 'Public' }]), 'public')).toBe('blocked')
    expect(firewallState(probe([{ action: 'Block', profile: 'Public', enabled: 'False' }]), 'public')).toBe('unknown')
  })

  it('the profile is the bound interface’s; "all interfaces" takes the strictest present', () => {
    const p = probe([], { 'vEthernet (ExternalSwitch)': 'Private', Hamachi: 'Public' })
    expect(activeProfile(p, 'vEthernet (ExternalSwitch)')).toBe('private')
    expect(activeProfile(p, null)).toBe('public')
    expect(activeProfile(probe([], { Corp: 'DomainAuthenticated' }), 'Corp')).toBe('domain')
  })

  it('only Vesper’s own enabled allow rule for this port and profile counts as "already allowed"', () => {
    const own = (r: Record<string, string>) =>
      parseFirewallProbe(JSON.stringify({ profiles: [], rules: [{ name: 'Vesper (LAN)', action: 'Allow', enabled: 'True', profile: 'Private, Public', port: '41731', ...r }] }))!
    expect(ownRuleAllows(own({}), 'public', 41731)).toBe(true)
    expect(ownRuleAllows(own({}), 'public', 41740)).toBe(false)
    expect(ownRuleAllows(own({ profile: 'Private' }), 'public', 41731)).toBe(false)
    expect(ownRuleAllows(own({ enabled: 'False' }), 'public', 41731)).toBe(false)
    expect(ownRuleAllows(own({ name: 'vesper.exe', port: 'Any', profile: 'Public' }), 'public', 41731)).toBe(false)
    // A rule whose port the probe couldn't read is not trusted.
    expect(ownRuleAllows(own({ port: '' }), 'public', 41731)).toBe(false)
  })

  it('ConvertTo-Json single objects and junk are handled', () => {
    expect(parseFirewallProbe(JSON.stringify({ profiles: { alias: 'Ethernet', category: 'Private' }, rules: null }))).toEqual({ profiles: [{ alias: 'Ethernet', category: 'Private' }], rules: [] })
    expect(parseFirewallProbe('\uFEFF{"profiles":[],"rules":[]}')).toEqual({ profiles: [], rules: [] })
    expect(parseFirewallProbe('Get-NetConnectionProfile : Access denied')).toBeNull()
  })
})

describe('POST /api/network/firewall/allow', () => {
  let t: AccessServer
  let runner: FakeRunner

  beforeAll(async () => {
    runner = new FakeRunner()
    // Listener B binds 127.0.0.1 as always in tests; the probe path is forced on as if it were a LAN address.
    t = await startAccessServer({
      runner,
      ports: { lan: 0 },
      program: () => EXE,
      firewallNeeded: () => true,
      interfaces: () => [{ address: '127.0.0.1', name: 'Ethernet' }]
    })
    await t.setPassword()
  })
  afterAll(() => t.close())

  it('LAN off → 409; on a Public network the status says so; the allow click runs exactly one elevated command', async () => {
    expect((await t.inject({ method: 'POST', url: '/api/network/firewall/allow', cookie: t.desktop, payload: {} })).statusCode).toBe(409)
    const browser = await t.login('browser')
    expect((await t.inject({ method: 'POST', url: '/api/network/firewall/allow', cookie: browser, payload: {} })).json().error.code).toBe('desktop_only')

    await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'lan' } })
    const s = (await t.inject({ url: '/api/network', cookie: t.desktop })).json()
    expect(s.lan).toMatchObject({ firewall: 'unknown', profile: 'public' })
    expect(s.warnings.map((w: { code: string }) => w.code)).toContain('network_public')
    expect(runner.lines('elevate')).toEqual([])

    runner.clear()
    runner.fw.rules = [{ name: 'Vesper', action: 'Block', enabled: 'True', profile: 'Public' }]
    // The click re-probes first, so a block rule Windows made in the meantime is removed in the same prompt.
    const after = await t.inject({ method: 'POST', url: '/api/network/firewall/allow', cookie: t.desktop, payload: { publicToo: true } })
    expect(after.statusCode).toBe(200)
    const elevated = runner.commands.filter((c) => c.kind === 'elevate')
    expect(elevated).toHaveLength(1)
    const script = decodePowerShell(elevated[0])
    expect(script).toContain(`netsh advfirewall firewall delete rule name=all program="${EXE}" dir=in`)
    expect(script).toContain('profile=private,public')
    expect(script).toContain(`localport=${after.json().lan.port}`)
    expect(runner.commands.filter((c) => c.kind === 'mutate')).toEqual([])
  })

  it('a cancelled UAC prompt is a clear 409 and is audited; success shows "allowed"', async () => {
    runner.fw.elevateCode = 1
    const r = await t.inject({ method: 'POST', url: '/api/network/firewall/allow', cookie: t.desktop, payload: {} })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.message).toMatch(/cancelled/)
    runner.fw.elevateCode = 0
    runner.fw.rules = [{ name: 'Vesper (LAN)', action: 'Allow', enabled: 'True', profile: 'Private, Public' }]
    const ok = await t.inject({ method: 'POST', url: '/api/network/firewall/allow', cookie: t.desktop, payload: {} })
    expect(ok.json().lan.firewall).toBe('allowed')
    const log = (await t.inject({ url: '/api/auth/log', cookie: t.desktop })).json() as { event: string; detail: string }[]
    expect(log.filter((e) => e.event === 'firewall.allow').map((e) => JSON.parse(e.detail).ok)).toEqual([true, false, true])
  })
})
