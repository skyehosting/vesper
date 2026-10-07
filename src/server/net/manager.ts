/**
 * Access manager (R1, 07 B2–B4, B14, D8, E8, E12; research 06 §3): turns `settings.access` + password + pause state
 * into running listeners and a Tailscale mapping, and reports it all as `NetworkStatus`.
 *   Listener B — LAN HTTPS on the chosen address (default: the default-route IP), self-signed EC certificate.
 *   Listener C — http://127.0.0.1:<tailnetPort> in Tailscale mode only; the one target of `tailscale serve`; its Host
 *                allow-list is this machine's ts.net name only.
 * Both need a password (07 B15). Every change runs through ONE serialized reconcile, so settings edits, password
 * changes, pause/resume and timers can never start or stop a listener twice. External programs go through the
 * injected CommandRunner; probes are cached (TTL) and deduplicated. Owns: listeners B/C, the Funnel timer, the
 * runner's children, change subscribers — all released in close().
 */
import type { NetworkPut, PairTarget } from '@shared/api'
import { VesperError } from '@shared/errors'
import type { AccessMode, NetworkStatus, NetworkWarning, NetworkWarningCode } from '@shared/types/domain'
import type { AccessAuth } from '../auth/service'
import { coreOf } from '../core'
import type { RunningListener } from '../http/listeners'
import type { Log, ServerContext } from '../services'
import { interfaceInfo, isPrivateIpv4, qrSvg, type Iface } from './addresses'
import {
  activeProfile,
  firewallAllowCommand,
  firewallCheckCommand,
  firewallRemoveCommand,
  firewallState,
  ownRuleAllows,
  parseFirewallProbe,
  type FirewallProbe,
  type FirewallState,
  type NetProfile
} from './firewall'
import type { CommandResult, CommandRunner } from './runner'
import { consentUrl, NOT_INSTALLED, parseServeStatus, parseStatus, parseVersion, transition, tsCommands, type ServeState, type TailscaleProbe } from './tailscale'
import { createCertManager, wantedSans, type generateLanCert, type LanCert } from './tls'
import { writeMappingMarker } from './uninstall'

export interface NetDeps {
  runner: CommandRunner
  interfaces(): Iface[]
  defaultRoute(): Promise<string | null>
  hostname(): string
  tailscaleExe(): string
  /** The executable Windows Firewall rules name (Vesper.exe when packaged). */
  program(): string
  /** Portable build (07 E8): no LAN mode. */
  portable(): boolean
  /** Test mode: Listener B may bind ONLY loopback addresses (127.x), so no test can ever trigger a firewall prompt. */
  loopbackOnly: boolean
  /** Tests: bind B/C on these ports (0 = random) instead of the settings' ports. */
  ports?: { lan?: number; tailnet?: number }
  generateCert?: typeof generateLanCert
  probeTtlMs?: number
  /** Does an address need a firewall rule? Default: everything but loopback (tests force the check path). */
  firewallNeeded?: (address: string) => boolean
  /**
   * 07 H-v111-firewall: turning Local network access on/off from the desktop adds/removes Vesper's firewall rules (one
   * UAC prompt each). Off in test mode; it also needs the desktop app (`platform.isDesktop`), so the standalone server
   * never tries. Tests turn it on with a fake runner.
   */
  autoFirewall?: boolean
  /** How often Listener B checks that its address still exists / the default route moved (default 30 s). */
  lanWatchMs?: number
  /**
   * Tailscale watcher (F08): while Listener C has no ts.net name, re-probe after `first`, doubling up to `max`
   * (default 5 s → 60 s); once it has one, re-check every `recheck` (default 5 min) for a renamed node or a stopped
   * daemon.
   */
  tailWatchMs?: { first: number; max: number; recheck: number }
}

export interface AccessNet {
  /** Synchronous snapshot (bootstrap, network status provider). */
  status(): NetworkStatus
  /** Re-run stale probes (Tailscale, firewall), then return the snapshot. */
  refresh(force?: boolean): Promise<NetworkStatus>
  reconcile(): Promise<void>
  update(put: NetworkPut, by: string): Promise<NetworkStatus>
  allowFirewall(publicToo: boolean): Promise<NetworkStatus>
  setTailscale(on: boolean, funnel: boolean, by: string): Promise<NetworkStatus>
  setPaused(paused: boolean): Promise<void>
  isPaused(): boolean
  defaultPairTarget(): PairTarget
  /** Origin + `/pair#c=` for a pairing link; throws `conflict` when that way in is not running. */
  pairBase(target: PairTarget): string
  onChange(fn: (s: NetworkStatus) => void): () => void
  /** Resolves after the first reconcile (once Listener A is up). */
  readonly ready: Promise<void>
  close(): Promise<void>
}

const MAPPING_KV = 'access.tailscale.mapping'
const FUNNEL_UNTIL_KV = 'access.funnelUntil'
const PAUSED_KV = 'access.paused'
const MAX_TIMER_MS = 2 ** 31 - 1

const WARNINGS: Record<NetworkWarningCode, string> = {
  password_required: 'Set a password first: devices other than this PC have to sign in.',
  portable: "The portable version can't offer Local network access. Install Vesper to use it.",
  lan_address_missing: "The network address chosen for Local network access isn't on this PC right now.",
  port_unavailable: 'The network port is busy. Choose another port in Settings → Access & security.',
  cert_failed: "Vesper couldn't create its HTTPS certificate.",
  firewall_blocked: 'Windows Firewall blocks Vesper on this network. Use "Allow through firewall" (asks for permission once).',
  firewall_unknown: "Windows may block other devices until Vesper is allowed through the firewall.",
  network_public:
    'This network is set to Public, so Windows blocks incoming connections. Set it to Private in Windows Settings → Network & internet, or allow Vesper through the firewall.',
  tailscale_missing: 'Tailscale is not installed on this PC.',
  tailscale_stopped: 'Tailscale is not running on this PC.',
  tailscale_signed_out: 'Sign in to Tailscale on this PC.',
  tailscale_https_off: 'Turn on HTTPS certificates for your tailnet in the Tailscale admin console.',
  tailscale_failed: "Tailscale didn't accept the change.",
  tailscale_consent: 'Tailscale needs your approval in its admin console (open the link on this PC).',
  funnel_public: 'Funnel is on: anyone on the Internet can reach your sign-in page.',
  remote_paused: 'Remote access is paused.',
  login_suspended: 'Sign-in from other devices is paused after too many wrong passwords.'
}

const warn = (code: NetworkWarningCode, message = WARNINGS[code]): NetworkWarning => ({ code, message })

const CAPS: Record<AccessMode, NetworkStatus['capabilities']> = {
  local: { mic: true, install: true, warningFree: true },
  // Self-signed: the mic works after accepting the certificate once; service workers and install don't (D8).
  lan: { mic: true, install: false, warningFree: false },
  tailscale: { mic: true, install: true, warningFree: true }
}

const isLoopback = (a: string) => /^127\./.test(a)
const errCode = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code

export function createAccessNet(ctx: ServerContext, auth: AccessAuth, deps: NetDeps): AccessNet {
  const log: Log = ctx.log.child('net')
  const core = coreOf(ctx)
  const ttl = deps.probeTtlMs ?? 15_000
  const certs = createCertManager({ dir: ctx.paths.roaming, secrets: ctx.platform.secrets, log, generate: deps.generateCert })
  const changeFns = new Set<(s: NetworkStatus) => void>()
  const firewallNeeded = deps.firewallNeeded ?? ((a: string) => !isLoopback(a))
  const autoFirewall = deps.autoFirewall === true && ctx.platform.isDesktop

  let closed = false
  let paused = ctx.repos.kv.get<boolean>(PAUSED_KV) === true
  let chain: Promise<void> = Promise.resolve()
  let lastJson = ''

  // Listener B
  let lan: { address: string; ifaceName: string | null; cert: LanCert; urls: string[]; qr: string | null } | null = null
  let lanWarning: NetworkWarning | null = null
  let recommended: string | null | undefined
  let lanWatch: NodeJS.Timeout | null = null
  // Firewall (`probe` null: not probed, not needed, or the probe failed)
  let fw: { state: FirewallState; profile: NetProfile; at: number; probe: FirewallProbe | null } | null = null
  let fwInflight: Promise<void> | null = null
  // Tailscale
  let ts: (TailscaleProbe & { at: number }) | null = null
  let tsInflight: Promise<void> | null = null
  let serve: ServeState | null = null
  let tsWarning: NetworkWarning | null = null
  /** Listener C could not bind (kept apart from tsWarning, which reconcileServe rewrites). */
  let tailWarning: NetworkWarning | null = null
  let consent: string | null = null
  let funnelTimer: NodeJS.Timeout | null = null
  let tailWatch: NodeJS.Timeout | null = null
  /** The current backoff step of the Tailscale watcher (0 = not backing off). */
  let tailBackoff = 0
  const tailTimes = deps.tailWatchMs ?? { first: 5_000, max: 60_000, recheck: 5 * 60_000 }

  const now = () => ctx.clock.now()
  const access = () => ctx.settings.get().access
  const run = (c: Parameters<CommandRunner['run']>[0]): Promise<CommandResult> => deps.runner.run(c)
  /** Vesper's mapping lives in kv, and in a small file the uninstaller can read (F74, see ./uninstall.ts). */
  const recordMapping = (m: { port: number; funnel: boolean } | null) => {
    if (m) ctx.repos.kv.set(MAPPING_KV, m)
    else ctx.repos.kv.delete(MAPPING_KV)
    writeMappingMarker(ctx.paths.roaming, m)
  }

  // ── probes ────────────────────────────────────────────────────────────────────────────────
  function probeTailscale(force: boolean): Promise<void> {
    if (!force && ts && now() - ts.at < ttl) return Promise.resolve()
    tsInflight ??= (async () => {
      const exe = deps.tailscaleExe()
      const v = parseVersion(await run(tsCommands.version(exe)))
      if (!v.installed) {
        ts = { ...NOT_INSTALLED, at: now() }
        return
      }
      ts = { installed: true, version: v.version, ...parseStatus(await run(tsCommands.status(exe))), at: now() }
    })()
      .catch((e: unknown) => log.warn('tailscale probe failed', { error: e }))
      .finally(() => {
        tsInflight = null
      })
    return tsInflight
  }

  function probeFirewall(force: boolean): Promise<void> {
    if (!lan) {
      fw = null
      return Promise.resolve()
    }
    if (!firewallNeeded(lan.address)) {
      fw = { state: 'not-needed', profile: 'unknown', at: now(), probe: null }
      return Promise.resolve()
    }
    if (!force && fw && now() - fw.at < ttl) return Promise.resolve()
    const iface = lan.ifaceName
    fwInflight ??= (async () => {
      const probe = parseFirewallProbe((await run(firewallCheckCommand(deps.program()))).stdout)
      if (!probe) {
        fw = { state: 'unknown', profile: 'unknown', at: now(), probe: null }
        return
      }
      const profile = activeProfile(probe, iface)
      fw = { state: firewallState(probe, profile), profile, at: now(), probe }
    })()
      .catch((e: unknown) => log.warn('firewall probe failed', { error: e }))
      .finally(() => {
        fwInflight = null
      })
    return fwInflight
  }

  // ── Listener B ────────────────────────────────────────────────────────────────────────────
  function lanHosts(address: string, ifaces: Iface[]): string[] {
    const host = deps.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')
    const names = address === '0.0.0.0' ? [...ifaces.map((i) => i.address), '127.0.0.1', 'localhost'] : [address]
    if (host) names.push(host, `${host}.local`)
    return [...new Set(names)]
  }

  function setGuard(l: RunningListener, hosts: string[], scheme: 'https'): void {
    l.guard.hosts.clear()
    l.guard.origins.clear()
    for (const h of hosts) {
      l.guard.hosts.add(h.toLowerCase())
      l.guard.origins.add(`${scheme}://${h.toLowerCase()}`)
    }
  }

  async function pickAddress(ifaces: Iface[]): Promise<string | null> {
    const chosen = access().lanAddress
    if (chosen) return chosen
    if (deps.loopbackOnly) return '127.0.0.1'
    recommended = await deps.defaultRoute()
    if (recommended && ifaces.some((i) => i.address === recommended)) return recommended
    return ifaces.find((i) => isPrivateIpv4(i.address))?.address ?? null
  }

  function addressAllowed(address: string, ifaces: Iface[]): boolean {
    if (deps.loopbackOnly) return isLoopback(address)
    return address === '0.0.0.0' || ifaces.some((i) => i.address === address)
  }

  async function stopLan(): Promise<void> {
    watchLan(false)
    await core.listeners.stop('lan')
    lan = null
    fw = null
  }

  /**
   * Addresses change (DHCP, Wi-Fi ↔ Ethernet, VPN): every lanWatchMs, a bound address that vanished, a moved default
   * route (automatic address) or new interfaces under "all interfaces" (certificate SANs, Host allow-list) trigger a
   * reconcile. The interval is unref'd and exists only while Listener B runs.
   */
  function watchLan(on: boolean): void {
    if (!on) {
      if (lanWatch) clearInterval(lanWatch)
      lanWatch = null
      return
    }
    if (lanWatch) return
    lanWatch = setInterval(() => void checkLan(), deps.lanWatchMs ?? 30_000)
    lanWatch.unref()
  }

  async function checkLan(): Promise<void> {
    const cur = lan
    if (!cur || closed) return
    const ifaces = deps.interfaces()
    let stale = false
    if (cur.address === '0.0.0.0') {
      const need = wantedSans({ hostname: deps.hostname(), addresses: ifaces.map((i) => i.address) })
      stale = !need.every((n) => cur.cert.sans.includes(n))
    } else if (!addressAllowed(cur.address, ifaces)) stale = true
    else if (!access().lanAddress && !deps.loopbackOnly) {
      recommended = await deps.defaultRoute()
      stale = !!recommended && recommended !== cur.address && ifaces.some((i) => i.address === recommended)
    }
    if (stale && lan === cur) {
      log.info('LAN addresses changed; rebinding')
      await reconcile()
    }
  }

  async function ensureLan(): Promise<void> {
    const s = access()
    const ifaces = deps.interfaces()
    const address = await pickAddress(ifaces)
    if (!address || !addressAllowed(address, ifaces)) {
      lanWarning = warn('lan_address_missing')
      return stopLan()
    }
    const addrs = address === '0.0.0.0' ? ifaces.map((i) => i.address) : [address]
    let cert: LanCert
    try {
      cert = await certs.ensure(wantedSans({ hostname: deps.hostname(), addresses: addrs }), now())
    } catch (e) {
      log.error('LAN certificate failed', { error: e })
      lanWarning = warn('cert_failed')
      return stopLan()
    }
    const hosts = lanHosts(address, ifaces)
    const port = deps.ports?.lan ?? s.lanPort
    const running = core.listeners.get('lan')
    if (running && lan && lan.address === address && lan.cert.fingerprint256 === cert.fingerprint256 && (port === 0 || running.port === port)) {
      setGuard(running, hosts.map((h) => `${h}:${running.port}`), 'https')
      lanWarning = null
      watchLan(true)
      return
    }
    await stopLan()
    let l: RunningListener
    try {
      l = await core.listeners.start({
        name: 'lan',
        bindHost: address,
        port,
        portRetries: port === 0 ? 0 : 10,
        https: { key: cert.key, cert: cert.cert },
        hosts: (p) => hosts.map((h) => `${h}:${p}`),
        origins: (p) => hosts.map((h) => `https://${h}:${p}`)
      })
    } catch (e) {
      const code = errCode(e)
      lanWarning = code === 'EADDRINUSE' || code === 'EACCES' ? warn('port_unavailable') : warn('lan_address_missing')
      log.warn('LAN listener failed to start', { code: code ?? String(e) })
      return
    }
    lanWarning = null
    const display = address === '0.0.0.0' ? (ifaces.find((i) => i.address === recommended)?.address ?? ifaces[0]?.address ?? '127.0.0.1') : address
    const host = deps.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '')
    const urls = [`https://${display}:${l.port}`, ...(host ? [`https://${host}.local:${l.port}`] : [])]
    let qr: string | null = null
    try {
      qr = await qrSvg(urls[0])
    } catch (e) {
      log.warn('QR generation failed', { error: e })
    }
    lan = { address, ifaceName: ifaces.find((i) => i.address === address)?.name ?? null, cert, urls, qr }
    watchLan(true)
    log.info('LAN listener on', { port: l.port, loopback: isLoopback(address) })
    if (port !== 0 && l.port !== s.lanPort) await ctx.settings.patch({ access: { lanPort: l.port } }).catch(() => undefined)
    // The firewall probe spawns PowerShell (~0.5 s); status updates when it lands.
    void probeFirewall(true).then(emit)
  }

  // ── Listener C + Tailscale ────────────────────────────────────────────────────────────────
  function tailHosts(): string[] {
    const dns = ts?.dnsName
    return dns ? [dns, `${dns}:443`] : []
  }

  function setTailGuard(l: RunningListener): void {
    l.guard.hosts.clear()
    l.guard.origins.clear()
    for (const h of tailHosts()) l.guard.hosts.add(h)
    if (ts?.dnsName) l.guard.origins.add(`https://${ts.dnsName}`)
  }

  async function ensureTailnet(): Promise<void> {
    const s = access()
    const port = deps.ports?.tailnet ?? s.tailnetPort
    let l = core.listeners.get('tailnet')
    tailWarning = null
    await probeTailscale(false)
    if (!l || (port !== 0 && l.port !== port)) {
      await core.listeners.stop('tailnet')
      try {
        l = await core.listeners.start({
          name: 'tailnet',
          bindHost: '127.0.0.1',
          port,
          portRetries: port === 0 ? 0 : 10,
          hosts: () => tailHosts(),
          origins: () => (ts?.dnsName ? [`https://${ts.dnsName}`] : [])
        })
      } catch (e) {
        tailWarning = warn('port_unavailable')
        log.warn('tailnet listener failed to start', { code: errCode(e) ?? String(e) })
        return
      }
      if (port !== 0 && l.port !== s.tailnetPort) await ctx.settings.patch({ access: { tailnetPort: l.port } }).catch(() => undefined)
    }
    setTailGuard(l)
  }

  /**
   * F08: Tailscale may not be 'Running' when Vesper reconciles (Vesper starts at Windows sign-in before tailscaled has
   * connected, or the daemon restarts). Listener C then has no ts.net name — every request on it gets 421 — and the
   * persisted `serve` mapping keeps sending the phone there. Like watchLan for Listener B, this timer exists only while
   * Listener C runs: it re-probes with backoff (first → max) until the name is known, then slowly (recheck) to follow a
   * rename or a stop. Any change runs the ONE serialized reconcile (guard + mapping + warnings). Unref'd.
   */
  function watchTail(on: boolean): void {
    if (!on || closed) {
      if (tailWatch) clearTimeout(tailWatch)
      tailWatch = null
      tailBackoff = 0
      return
    }
    if (tailWatch) return
    let delay: number
    if (ts?.dnsName && (core.listeners.get('tailnet')?.guard.hosts.size ?? 0) > 0) {
      tailBackoff = 0
      delay = tailTimes.recheck
    } else {
      tailBackoff = tailBackoff ? Math.min(tailTimes.max, tailBackoff * 2) : tailTimes.first
      delay = tailBackoff
    }
    tailWatch = setTimeout(() => {
      tailWatch = null
      void checkTail()
    }, delay)
    tailWatch.unref()
  }

  async function checkTail(): Promise<void> {
    if (closed || !core.listeners.get('tailnet')) return
    const before = ts ? { running: ts.running, signedIn: ts.signedIn, dnsName: ts.dnsName, https: ts.httpsEnabled } : null
    await probeTailscale(true)
    const l = core.listeners.get('tailnet')
    if (closed || !l) return
    const after = ts ? { running: ts.running, signedIn: ts.signedIn, dnsName: ts.dnsName, https: ts.httpsEnabled } : null
    const guardStale = !!ts?.dnsName && !l.guard.hosts.has(ts.dnsName)
    if (guardStale || JSON.stringify(before) !== JSON.stringify(after)) {
      log.info('Tailscale state changed; reconciling', { running: after?.running ?? false, signedIn: after?.signedIn ?? false })
      await reconcile() // re-arms the watcher (doReconcile → watchTail)
      return
    }
    watchTail(true)
  }

  /**
   * Bring the Serve/Funnel mapping in line (07 B14). Never touches the CLI unless Tailscale mode is on or an earlier
   * Vesper mapping is recorded (startup reconcile after a crash, mode change, quit).
   */
  async function reconcileServe(wanted: boolean): Promise<void> {
    const s = access()
    const recorded = ctx.repos.kv.get<{ port: number; funnel: boolean }>(MAPPING_KV)
    // While paused (Listener C down) the mapping keeps pointing where it did.
    const port = core.listeners.get('tailnet')?.port ?? recorded?.port ?? s.tailnetPort
    const desired = wanted ? { port, funnel: s.funnel } : null
    tsWarning = null
    consent = null
    if (!desired && !recorded) {
      serve = null
      return
    }
    await probeTailscale(false)
    if (!ts?.installed) {
      if (desired) tsWarning = warn('tailscale_missing')
      return
    }
    if (!ts.running) {
      if (desired) tsWarning = warn('tailscale_stopped')
      return
    }
    if (!ts.signedIn) {
      if (desired) tsWarning = warn('tailscale_signed_out')
      return
    }
    if (desired && !ts.httpsEnabled) tsWarning = warn('tailscale_https_off')
    const exe = deps.tailscaleExe()
    const current = parseServeStatus(await run(tsCommands.serveStatus(exe)), ts.dnsName)
    const ours = [s.tailnetPort, recorded?.port, desired?.port, deps.ports?.tailnet].filter((p): p is number => typeof p === 'number' && p > 0)
    if (desired && current.port !== null && !ours.includes(current.port)) {
      // HTTPS 443 already proxies somewhere else: that is the owner's own setup; never overwrite it.
      tsWarning = warn('tailscale_failed', "HTTPS on this PC's Tailscale name is already used by another Tailscale Serve setting.")
      serve = current
      return
    }
    const cmds = transition(exe, current, ours, desired)
    for (const c of cmds) {
      const r = await run(c)
      if (r.code !== 0) {
        consent = consentUrl(r)
        tsWarning = consent ? warn('tailscale_consent') : warn('tailscale_failed')
        log.warn('tailscale command failed', { args: c.args.slice(0, 2), code: r.code, error: r.error })
        serve = parseServeStatus(await run(tsCommands.serveStatus(exe)), ts.dnsName)
        return
      }
    }
    if (cmds.length) auth.audit(desired ? (desired.funnel ? 'tailscale.funnel' : 'tailscale.serve') : 'tailscale.off', null, desired ? { port: desired.port } : undefined)
    recordMapping(desired)
    serve = desired ? { port: desired.port, funnel: desired.funnel } : { port: null, funnel: false }
  }

  /** Funnel auto-off (07 B14, default 8 h): the deadline survives restarts in kv; the timer is unref'd. */
  async function funnelDeadline(wanted: boolean): Promise<void> {
    const s = access()
    if (funnelTimer) clearTimeout(funnelTimer)
    funnelTimer = null
    if (!(wanted && s.funnel && s.funnelAutoOffHours > 0)) {
      if (!s.funnel) ctx.repos.kv.delete(FUNNEL_UNTIL_KV)
      return
    }
    let until = ctx.repos.kv.get<number>(FUNNEL_UNTIL_KV)
    if (typeof until !== 'number') {
      until = now() + s.funnelAutoOffHours * 3_600_000
      ctx.repos.kv.set(FUNNEL_UNTIL_KV, until)
    }
    if (now() >= until) {
      auth.audit('tailscale.funnel-auto-off', null)
      ctx.repos.kv.delete(FUNNEL_UNTIL_KV)
      ctx.platform.notify('Vesper turned Funnel off', 'Public Internet access ended on schedule. Tailscale access within your tailnet stays on.')
      await ctx.settings.patch({ access: { funnel: false } }).catch((e: unknown) => log.warn('funnel auto-off failed', { error: e }))
      return
    }
    funnelTimer = setTimeout(() => void reconcile(), Math.min(MAX_TIMER_MS, until - now()))
    funnelTimer.unref()
  }

  // ── firewall follows Local network access (07 H-v111-firewall) ─────────────────────────────
  /**
   * After a desktop change: turning Local network access on (or moving its port or address) makes sure the
   * "Vesper (LAN)" rule allows that port on the network's profile; turning it off removes every inbound rule of this
   * Vesper.exe. One UAC prompt each, and none when the probe shows nothing to do. A cancelled or failed prompt changes
   * nothing else: Local network access stays on and the panel shows the firewall state with the manual
   * "Allow in Windows Firewall…" button. Runs outside the reconcile queue (the prompt can wait up to 2 minutes).
   */
  async function syncFirewall(before: { mode: AccessMode; lanPort: number; lanAddress: string | null }): Promise<void> {
    if (!autoFirewall || closed) return
    const s = access()
    if (s.mode === 'lan') {
      if (before.mode !== 'lan' || before.lanPort !== s.lanPort || before.lanAddress !== s.lanAddress) await ensureFirewallRule()
    } else if (before.mode === 'lan') await removeFirewallRules()
  }

  async function ensureFirewallRule(): Promise<void> {
    const l = core.listeners.get('lan')
    if (!lan || !l || !firewallNeeded(lan.address)) return
    await probeFirewall(true)
    const cur = fw
    // No probe (PowerShell failed): don't prompt blindly; the panel offers the manual button.
    if (!cur?.probe || closed) return
    if (cur.state !== 'blocked' && ownRuleAllows(cur.probe, cur.profile, l.port)) return
    const publicToo = cur.profile === 'public'
    const r = await deps.runner.run(
      firewallAllowCommand({ program: deps.program(), port: l.port, publicToo, domainToo: cur.profile === 'domain', removeBlocks: cur.state === 'blocked' })
    )
    auth.audit('firewall.allow', null, { ok: r.code === 0, publicToo })
    if (r.code !== 0) log.warn('firewall rule not added (prompt cancelled or failed)', { code: r.code, error: r.error })
    await probeFirewall(true)
  }

  async function removeFirewallRules(): Promise<void> {
    const program = deps.program()
    const probe = parseFirewallProbe((await run(firewallCheckCommand(program))).stdout)
    if (!probe?.rules.length || closed) return
    const r = await deps.runner.run(firewallRemoveCommand(program))
    auth.audit('firewall.remove', null, { ok: r.code === 0 })
    if (r.code !== 0) log.warn('firewall rules not removed (prompt cancelled or failed)', { code: r.code, error: r.error })
  }

  // ── reconcile ─────────────────────────────────────────────────────────────────────────────
  async function doReconcile(): Promise<void> {
    if (closed) return
    const s = access()
    const pw = auth.passwordSet()
    const wantLan = s.mode === 'lan' && pw && !deps.portable() && !paused
    const wantTail = s.mode === 'tailscale' && pw && !paused
    if (wantLan) await ensureLan()
    else {
      lanWarning = null
      await stopLan()
    }
    if (wantTail) await ensureTailnet()
    else {
      tailWarning = null
      await core.listeners.stop('tailnet')
    }
    // Pausing stops Listener C but keeps the mapping: resuming is instant, and Tailscale answers 502 meanwhile.
    await reconcileServe(s.mode === 'tailscale' && pw)
    await funnelDeadline(s.mode === 'tailscale' && pw)
    // F08: re-arm from the state this reconcile left (a backoff step if C still has no name, else the slow re-check).
    if (tailWatch) clearTimeout(tailWatch)
    tailWatch = null
    watchTail(wantTail && !!core.listeners.get('tailnet'))
  }

  /**
   * Queue a reconcile. Requests made before the queued one starts share it (a settings change and the route that made
   * it ask together), so one change never runs the Tailscale commands twice.
   */
  let queued: Promise<void> | null = null
  let requests = 0
  let lastRequested: Promise<void> = Promise.resolve()
  function reconcile(): Promise<void> {
    requests++
    lastRequested = queueReconcile()
    return lastRequested
  }
  function queueReconcile(): Promise<void> {
    if (queued) return queued
    const next = chain
      .then(() => {
        queued = null
        return doReconcile()
      })
      .catch((e: unknown) => log.error('access reconcile failed', { error: e }))
      .then(emit)
    chain = next
    queued = next
    return next
  }

  // ── status ────────────────────────────────────────────────────────────────────────────────
  function status(): NetworkStatus {
    const s = access()
    const pw = auth.passwordSet()
    const lanL = core.listeners.get('lan')
    const tailL = core.listeners.get('tailnet')
    const portable = deps.portable()
    const port = core.listeners.get('loopback')?.port ?? s.port
    const warnings: NetworkWarning[] = []
    if (s.mode !== 'local' && !pw) warnings.push(warn('password_required'))
    if (s.mode === 'lan' && portable) warnings.push(warn('portable'))
    if (paused) warnings.push(warn('remote_paused'))
    if (auth.loginSuspended()) warnings.push(warn('login_suspended'))
    if (s.mode === 'lan' && lanWarning) warnings.push(lanWarning)
    if (s.mode === 'lan' && lan && fw) {
      if (fw.state === 'blocked') warnings.push(warn('firewall_blocked'))
      else if (fw.state === 'unknown' && fw.profile === 'public') warnings.push(warn('network_public'))
      else if (fw.state === 'unknown') warnings.push(warn('firewall_unknown'))
    }
    if (s.mode === 'tailscale' && tailWarning) warnings.push(tailWarning)
    if (s.mode === 'tailscale' && tsWarning) warnings.push(tsWarning)
    const serving = !!serve?.port
    if (s.mode === 'tailscale' && serving && serve?.funnel) warnings.push(warn('funnel_public'))
    const cert = lan?.cert ?? certs.current()
    return {
      mode: s.mode,
      loopback: { port, url: `http://127.0.0.1:${port}`, browserUrl: `http://vesper.localhost:${port}` },
      lan:
        s.mode === 'lan' || lanL
          ? {
              address: lan?.address ?? s.lanAddress,
              port: lanL?.port ?? s.lanPort,
              url: lan && lanL ? lan.urls[0] : null,
              certFingerprint: cert?.fingerprint256 ?? null,
              firewall: fw?.state ?? 'unknown',
              profile: fw?.profile ?? 'unknown',
              running: !!lanL,
              urls: lan && lanL ? lan.urls : [],
              qrSvg: lan && lanL ? lan.qr : null,
              certExpiresUtc: cert?.notAfterUtc ?? null
            }
          : null,
      tailscale: ts
        ? {
            installed: ts.installed,
            running: ts.running,
            signedIn: ts.signedIn,
            dnsName: ts.dnsName,
            serving,
            funnel: serving && !!serve?.funnel,
            url: serving && ts.dnsName ? `https://${ts.dnsName}` : null,
            version: ts.version,
            httpsEnabled: ts.httpsEnabled,
            funnelUntilUtc: serving && serve?.funnel ? (ctx.repos.kv.get<number>(FUNNEL_UNTIL_KV) ?? null) : null,
            listenerPort: tailL?.port ?? null,
            consentUrl: consent
          }
        : null,
      passwordSet: pw,
      portable,
      capabilities: CAPS[s.mode],
      interfaces: deps.loopbackOnly ? [] : interfaceInfo(deps.interfaces(), recommended ?? null),
      remote: { paused, loginSuspended: auth.loginSuspended() },
      warnings
    }
  }

  function emit(): void {
    if (closed) return
    const s = status()
    const json = JSON.stringify(s)
    if (json === lastJson) return
    lastJson = json
    ctx.hub.broadcast({ t: 'network.changed', network: s })
    for (const fn of changeFns) {
      try {
        fn(s)
      } catch (e) {
        log.warn('network change listener failed', { error: e })
      }
    }
  }

  // ── actions ───────────────────────────────────────────────────────────────────────────────
  function validatePut(put: NetworkPut): void {
    const s = access()
    const fields: Record<string, string> = {}
    const mode = put.mode ?? s.mode
    if (put.mode && put.mode !== 'local' && put.mode !== s.mode && !auth.passwordSet()) fields.mode = WARNINGS.password_required
    if (put.mode === 'lan' && deps.portable()) fields.mode = WARNINGS.portable
    if (put.funnel === true && mode !== 'tailscale') fields.funnel = 'Funnel works only in Tailscale mode.'
    if (put.funnel === true && !auth.passwordSet()) fields.funnel = WARNINGS.password_required
    if (put.lanAddress !== undefined && put.lanAddress !== null && !addressAllowed(put.lanAddress, deps.interfaces())) {
      fields.lanAddress = deps.loopbackOnly ? 'Test builds bind Local network access to loopback addresses only.' : "That address isn't on this PC."
    }
    const ports = { port: put.port ?? s.port, lanPort: put.lanPort ?? s.lanPort, tailnetPort: put.tailnetPort ?? s.tailnetPort }
    if (new Set(Object.values(ports)).size !== 3) fields[put.lanPort !== undefined ? 'lanPort' : put.tailnetPort !== undefined ? 'tailnetPort' : 'port'] = 'Each listener needs its own port.'
    if (Object.keys(fields).length) throw new VesperError('validation', { fields })
  }

  async function update(put: NetworkPut, by: string): Promise<NetworkStatus> {
    validatePut(put)
    const before = access()
    const was = { mode: before.mode, lanPort: before.lanPort, lanAddress: before.lanAddress }
    const patch: Record<string, unknown> = {}
    for (const k of ['mode', 'port', 'lanAddress', 'lanPort', 'tailnetPort', 'funnel', 'funnelAutoOffHours', 'keepRemoteWhileClosed'] as const) {
      if (put[k] !== undefined) patch[k] = put[k]
    }
    // The owner may have just installed or signed in to Tailscale: don't trust a cached probe for this change.
    if (put.mode === 'tailscale' || (put.mode === undefined && before.mode === 'tailscale')) await probeTailscale(true)
    // A fresh Funnel gets a fresh auto-off deadline.
    if (put.funnel === true && !before.funnel) ctx.repos.kv.delete(FUNNEL_UNTIL_KV)
    if (put.resumeRemoteLogin) auth.resumeRemoteLogin()
    if (put.paused !== undefined) applyPaused(put.paused)
    const mark = requests
    if (Object.keys(patch).length) {
      await ctx.settings.patch({ access: patch }, { by })
      auth.audit('network.change', null, { ...patch, by })
    }
    // The settings subscription already queued the reconcile that covers this change; wait for that one, so one
    // request never runs the Tailscale commands twice.
    if (requests === mark) reconcile()
    await lastRequested
    await syncFirewall(was)
    return refresh(false)
  }

  function applyPaused(p: boolean): void {
    if (p === paused) return
    paused = p
    if (p) ctx.repos.kv.set(PAUSED_KV, true)
    else ctx.repos.kv.delete(PAUSED_KV)
    auth.audit(p ? 'network.pause' : 'network.resume', null)
  }

  async function setPaused(p: boolean): Promise<void> {
    applyPaused(p)
    await reconcile()
  }

  async function refresh(force = false): Promise<NetworkStatus> {
    // The picker marks the default-route interface; finding it sends no packet (UDP connect only).
    if (!deps.loopbackOnly && (recommended === undefined || force)) recommended = await deps.defaultRoute()
    await Promise.all([probeTailscale(force), lan ? probeFirewall(force) : Promise.resolve()])
    const l = core.listeners.get('tailnet')
    if (l) setTailGuard(l)
    emit()
    return status()
  }

  const ready = (async () => {
    // Listener A starts after the WS handlers register; B/C come up only once A exists (a failed startup must not
    // leave a LAN listener behind). Bounded wait, unref'd timers.
    for (let i = 0; i < 1200 && !closed && !core.listeners.get('loopback'); i++) {
      await new Promise((r) => setTimeout(r, 25).unref())
    }
    if (!closed && core.listeners.get('loopback')) await reconcile()
  })()

  return {
    status,
    refresh,
    reconcile,
    update,
    setPaused,
    isPaused: () => paused,

    async allowFirewall(publicToo) {
      if (!lan || !core.listeners.get('lan')) throw new VesperError('conflict', { message: 'Turn on Local network access first.' })
      if (!firewallNeeded(lan.address)) return status()
      await probeFirewall(true)
      const cmd = firewallAllowCommand({ program: deps.program(), port: core.listeners.get('lan')!.port, publicToo, removeBlocks: fw?.state === 'blocked' })
      const r = await deps.runner.run(cmd)
      auth.audit('firewall.allow', null, { ok: r.code === 0, publicToo })
      await probeFirewall(true)
      emit()
      if (r.code !== 0) throw new VesperError('conflict', { message: "Windows didn't change the firewall (the permission prompt was cancelled or failed)." })
      return status()
    },

    async setTailscale(on, funnel, by) {
      const s = access()
      if (on) return update({ mode: 'tailscale', funnel }, by)
      return update({ funnel: false, ...(s.mode === 'tailscale' ? { mode: 'local' as const } : {}) }, by)
    },

    defaultPairTarget() {
      const s = access()
      if (s.mode === 'lan' && lan && core.listeners.get('lan')) return 'lan'
      if (s.mode === 'tailscale' && ts?.dnsName && core.listeners.get('tailnet')) return 'tailnet'
      return 'local'
    },

    pairBase(target) {
      if (target === 'local') return `${status().loopback.browserUrl}/pair#c=`
      if (target === 'lan') {
        if (!lan || !core.listeners.get('lan')) throw new VesperError('conflict', { message: 'Turn on Local network access first.' })
        return `${lan.urls[0]}/pair#c=`
      }
      if (!ts?.dnsName || !core.listeners.get('tailnet')) throw new VesperError('conflict', { message: 'Turn on Tailscale access first.' })
      return `https://${ts.dnsName}/pair#c=`
    },

    onChange(fn) {
      changeFns.add(fn)
      return () => changeFns.delete(fn)
    },

    ready,

    async close() {
      closed = true
      if (funnelTimer) clearTimeout(funnelTimer)
      funnelTimer = null
      watchLan(false)
      watchTail(false)
      await ready.catch(() => undefined)
      await chain.catch(() => undefined)
      await core.listeners.stop('lan').catch(() => undefined)
      await core.listeners.stop('tailnet').catch(() => undefined)
      // 07 B14: quitting removes Vesper's Tailscale mapping unless the owner keeps remote access while closed.
      const recorded = ctx.repos.kv.get<{ port: number; funnel: boolean }>(MAPPING_KV)
      if (recorded && !access().keepRemoteWhileClosed && ts?.installed !== false) {
        const exe = deps.tailscaleExe()
        let ok = true
        for (const c of transition(exe, { port: recorded.port, funnel: recorded.funnel }, [recorded.port], null)) {
          const r = await deps.runner.run({ ...c, timeoutMs: 3000 })
          ok &&= r.code === 0
        }
        if (ok) recordMapping(null)
      }
      deps.runner.close()
      changeFns.clear()
    }
  }
}
