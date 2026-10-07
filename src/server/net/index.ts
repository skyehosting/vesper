/**
 * The access module's one instance per server: auth (password, lockout, sudo, pairing, devices) + net (listeners B/C,
 * Tailscale, firewall, status). Route modules run once PER LISTENER, so they never hold state themselves; they reach
 * this through `accessOf(ctx)`. The Electron shell (tray, autostart) reaches it the same way through RunningServer.ctx.
 */
import os from 'node:os'
import { coreOf } from '../core'
import type { ServerContext } from '../services'
import { isTestMode } from '../testMode'
import { createAccessAuth, type AccessAuth, type AuthDeps } from '../auth/service'
import { defaultRouteAddress, listIpv4 } from './addresses'
import { createAccessNet, type AccessNet, type NetDeps } from './manager'
import { createDryRunner, createRealRunner } from './runner'
import { findTailscale } from './tailscale'

export interface Access {
  auth: AccessAuth
  net: AccessNet
  close(): Promise<void>
}

const registry = new WeakMap<ServerContext, Access>()

export function accessOf(ctx: ServerContext): Access {
  const a = registry.get(ctx)
  if (!a) throw new Error('access module not registered')
  return a
}

export function tryAccessOf(ctx: ServerContext): Access | undefined {
  return registry.get(ctx)
}

export type AccessTestDeps = Partial<NetDeps> & AuthDeps

let testDeps: AccessTestDeps | null = null

/** Unit tests: fakes for the next server(s) started in this process (runner, ports, scrypt cost, limiter). */
export function setAccessTestDeps(d: AccessTestDeps | null): void {
  if (__VESPER_TEST__) testDeps = d
}

export function createAccess(ctx: ServerContext): Access {
  const test = isTestMode()
  let exe: string | null = null
  const defaults: NetDeps = {
    // Test mode never executes anything (07 B10 + the owner's rule): commands are recorded by the dry runner.
    runner: test ? createDryRunner() : createRealRunner(),
    interfaces: () => listIpv4(),
    defaultRoute: test ? async () => null : () => defaultRouteAddress(),
    hostname: () => os.hostname(),
    tailscaleExe: () => (exe ??= findTailscale()),
    program: () => process.execPath,
    portable: () => !!process.env.PORTABLE_EXECUTABLE_FILE,
    loopbackOnly: test,
    // The firewall follows Local network access in the desktop app only (the manager also checks platform.isDesktop).
    autoFirewall: !test
  }
  const extra = __VESPER_TEST__ && testDeps ? testDeps : {}
  const auth = createAccessAuth(ctx, { scrypt: extra.scrypt, limiter: extra.limiter })
  const net = createAccessNet(ctx, auth, { ...defaults, ...extra })
  const unsubscribe = ctx.settings.subscribe('access', () => void net.reconcile())
  const offPassword = auth.onPasswordChanged(() => void net.reconcile())
  const core = coreOf(ctx)
  core.auth.setStateProvider(() => ({ ...auth.state(), signedIn: false, pendingApproval: false }))
  core.setNetworkStatusProvider(() => net.status())
  const access: Access = {
    auth,
    net,
    async close() {
      unsubscribe()
      offPassword()
      await net.close()
    }
  }
  registry.set(ctx, access)
  return access
}
