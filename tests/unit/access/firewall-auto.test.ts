/**
 * The firewall follows Local network access in the desktop app (07 H-v111-firewall): turning it on adds the
 * "Vesper (LAN)" rule, turning it off removes Vesper's inbound rules, a port change updates the rule — one elevated
 * command each, none when the probe shows nothing to do. Never in the standalone server or in test mode. Nothing is
 * executed: the fake runner answers the probe and applies the netsh lines of a "successful" elevation to its rules. @R1
 */
import net, { type AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { elevatedLines, FakeRunner } from './fakeRunner'
import { startAccessServer, type AccessServer } from './helpers'

const EXE = 'C:\\Users\\Raven\\AppData\\Local\\Programs\\Vesper\\Vesper.exe'
const DROP_OWN = 'netsh advfirewall firewall delete rule name="Vesper (LAN)"'
const ADD = (port: number, profile = 'private,public') =>
  `netsh advfirewall firewall add rule name="Vesper (LAN)" dir=in action=allow program="${EXE}" protocol=TCP localport=${port} remoteip=localsubnet profile=${profile} enable=yes`
const REMOVE = `netsh advfirewall firewall delete rule name=all program="${EXE}" dir=in`
/** What Windows' own "allow" dialog made for vesper.exe on the owner's PC: TCP and UDP, every port, Public. */
const WINDOWS_RULES = () => [
  { name: 'vesper.exe', action: 'Allow', enabled: 'True', profile: 'Public', port: 'Any' },
  { name: 'vesper.exe', action: 'Allow', enabled: 'True', profile: 'Public', port: 'Any' }
]

const deps = (runner: FakeRunner) => ({
  runner,
  autoFirewall: true,
  program: () => EXE,
  // Listener B binds 127.0.0.1 as always in tests; the firewall path is forced on as if it were a LAN address.
  firewallNeeded: () => true,
  interfaces: () => [{ address: '127.0.0.1', name: 'Ethernet' }]
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as AddressInfo).port
      srv.close(() => resolve(p))
    })
  })
}

async function twoPorts(): Promise<[number, number]> {
  const a = await freePort()
  let b = await freePort()
  while (b === a) b = await freePort()
  return [a, b]
}

const elevated = (r: FakeRunner) => r.commands.filter((c) => c.kind === 'elevate').map(elevatedLines)
const codes = (s: { warnings: { code: string }[] }) => s.warnings.map((w) => w.code)

describe('desktop app: the firewall follows Local network access', () => {
  let t: AccessServer
  let runner: FakeRunner
  let p1: number
  let p2: number
  const put = async (payload: object) => {
    const r = await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload })
    expect(r.statusCode).toBe(200)
    return r.json()
  }

  beforeAll(async () => {
    runner = new FakeRunner()
    runner.applyNetsh = true
    t = await startAccessServer(deps(runner), { desktopApp: true })
    await t.setPassword()
    ;[p1, p2] = await twoPorts()
    await put({ lanPort: p1 })
    runner.fw.rules = WINDOWS_RULES()
  })
  afterAll(() => t.close())

  it('turning it on adds "Vesper (LAN)" with one prompt, Public included on a Public network (Windows’ all-ports rules don’t count)', async () => {
    runner.clear()
    const s = await put({ mode: 'lan' })
    expect(s.lan).toMatchObject({ running: true, port: p1, profile: 'public', firewall: 'allowed' })
    expect(elevated(runner)).toEqual([[DROP_OWN, ADD(p1)]])
    expect(runner.commands.filter((c) => c.kind === 'mutate')).toEqual([])
  })

  it('changing the port while on updates the rule (one prompt)', async () => {
    runner.clear()
    const s = await put({ lanPort: p2 })
    expect(s.lan).toMatchObject({ running: true, port: p2 })
    expect(elevated(runner)).toEqual([[DROP_OWN, ADD(p2)]])
  })

  it('turning it off removes every inbound rule of this Vesper.exe — its own and Windows’ — with one prompt', async () => {
    expect(runner.fw.rules.map((r) => r.name)).toEqual(['vesper.exe', 'vesper.exe', 'Vesper (LAN)'])
    runner.clear()
    const s = await put({ mode: 'local' })
    expect(s.lan).toBeNull()
    expect(elevated(runner)).toEqual([[REMOVE]])
    expect(runner.fw.rules).toEqual([])
  })

  it('no prompt when its own rule already allows the port, nor when there is nothing to remove', async () => {
    runner.fw.rules = [{ name: 'Vesper (LAN)', action: 'Allow', enabled: 'True', profile: 'Private, Public', port: String(p2) }]
    runner.clear()
    const on = await put({ mode: 'lan' })
    expect(on.lan).toMatchObject({ running: true, firewall: 'allowed' })
    expect(elevated(runner)).toEqual([])

    runner.fw.rules = []
    runner.clear()
    await put({ mode: 'local' })
    expect(runner.lines('probe').length).toBeGreaterThan(0)
    expect(elevated(runner)).toEqual([])
  })

  it('a cancelled prompt keeps Local network access on and shows the blocked state; the manual button still works', async () => {
    // Windows made a block rule when its own prompt was cancelled: the same prompt removes it.
    runner.fw.rules = [{ name: 'vesper.exe', action: 'Block', enabled: 'True', profile: 'Public', port: 'Any' }]
    runner.fw.elevateCode = 1
    runner.clear()
    const s = await put({ mode: 'lan' })
    expect(s.mode).toBe('lan')
    expect(s.lan).toMatchObject({ running: true, firewall: 'blocked', profile: 'public' })
    expect(codes(s)).toContain('firewall_blocked')
    expect(elevated(runner)).toEqual([[REMOVE, DROP_OWN, ADD(p2)]])

    runner.fw.elevateCode = 0
    const ok = await t.inject({ method: 'POST', url: '/api/network/firewall/allow', cookie: t.desktop, payload: { publicToo: true } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().lan.firewall).toBe('allowed')
    const log = (await t.inject({ url: '/api/auth/log', cookie: t.desktop })).json() as { event: string; detail: string }[]
    expect(log.filter((e) => e.event === 'firewall.allow').map((e) => JSON.parse(e.detail).ok)).toEqual([true, false, true, true])
    expect(log.filter((e) => e.event === 'firewall.remove').map((e) => JSON.parse(e.detail).ok)).toEqual([true])
  })
})

describe('never outside the desktop app', () => {
  async function cycle(t: AccessServer, runner: FakeRunner): Promise<void> {
    await t.setPassword()
    const [a, b] = await twoPorts()
    await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { lanPort: a } })
    runner.fw.rules = WINDOWS_RULES()
    expect((await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'lan' } })).json().lan.running).toBe(true)
    await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { lanPort: b } })
    await t.inject({ method: 'PUT', url: '/api/network', cookie: t.desktop, payload: { mode: 'local' } })
    expect(runner.lines('elevate')).toEqual([])
    expect(runner.fw.rules).toHaveLength(2)
  }

  it('the standalone server (browser-only use) never prompts', async () => {
    const runner = new FakeRunner()
    const t = await startAccessServer(deps(runner))
    try {
      expect(t.server.ctx.platform.isDesktop).toBe(false)
      await cycle(t, runner)
    } finally {
      await t.close()
    }
  })

  it('test mode never prompts, even in the desktop app (the default is off)', async () => {
    const runner = new FakeRunner()
    const { autoFirewall: _off, ...rest } = deps(runner)
    const t = await startAccessServer(rest, { desktopApp: true })
    try {
      await cycle(t, runner)
    } finally {
      await t.close()
    }
  })
})
