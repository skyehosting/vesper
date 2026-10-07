/**
 * Access auth beyond the core (07 B2/B4/B14–B16, research 06 §5): password set/change, login with lockout, sudo,
 * pairing with desktop approval, device approval/revocation, the audit log and desktop notifications. Builds on the
 * auth core's `createDevice` / `revoke` (src/server/auth/core.ts); one instance per server (routes on every listener
 * share it through `accessOf(ctx)`).
 */
import type { AuthStateBase, PairTarget } from '@shared/api'
import { VesperError } from '@shared/errors'
import type { DeviceInfo, Listener } from '@shared/types/domain'
import type { RequestAuth } from './core'
import { coreOf } from '../core'
import type { Log, ServerContext } from '../services'
import { LoginLimiter, type LimiterOptions, type LimitKind } from './limiter'
import { PairingCodes } from './pairing'
import { hashPassword, passwordProblem, ScryptQueue, SCRYPT_DEFAULT, verifyPassword, type ScryptParams } from './password'
import { createPasswordStore, type PasswordStore } from './passwordStore'

/** 07 B2: the password re-entered within 10 minutes. */
export const SUDO_MS = 10 * 60_000
/** A pending (paired, not yet approved) device that nobody approves is dropped after this. */
export const PENDING_TTL_MS = 10 * 60_000
const AUDIT_KEEP = 5000
const SUSPENDED_KV = 'access.loginSuspended'

export interface AuthDeps {
  scrypt?: ScryptParams
  limiter?: Partial<LimiterOptions>
}

export interface Caller {
  listener: Listener
  ip: string | null
  userAgent: string | null
  /** Display-only identity a proxy added (Tailscale-User-Login on Listener C); never used for authentication. */
  proxyUser?: string | null
}

export interface AccessAuth {
  passwordSet(): boolean
  state(): AuthStateBase
  login(password: string, deviceName: string, who: Caller, previous: RequestAuth | null): Promise<{ deviceId: string; token: string }>
  sudo(me: RequestAuth, password: string, who: Caller): Promise<number>
  setPassword(me: RequestAuth, body: { current?: string; next: string }, who: Caller): Promise<void>
  createPairing(target: PairTarget): { code: string; expiresUtc: number }
  /** `previous`: the caller's current session, replaced like a repeated login (F12). */
  redeemPairing(code: string, deviceName: string, who: Caller, previous?: RequestAuth | null): { deviceId: string; token: string; pending: boolean }
  approve(deviceId: string, allow: boolean): void
  revokeDevice(deviceId: string, me: RequestAuth, who: Caller): void
  devices(me: RequestAuth): DeviceInfo[]
  /** Revoke pending devices nobody approved within PENDING_TTL_MS. */
  sweepPending(): void
  log(limit: number): { tsUtc: number; event: string; ip: string | null; detail: string | null }[]
  audit(event: string, who: Pick<Caller, 'ip'> | null, detail?: Record<string, unknown>): void
  loginSuspended(): boolean
  resumeRemoteLogin(): void
  /** Called after the password was set or changed (network access may now start). */
  onPasswordChanged(fn: () => void): () => void
  /** Live buckets / codes / queued hashes (leak tests). */
  stats(): { limiterBuckets: number; pairingCodes: number; scryptQueue: number }
}

/** Device names are user text shown in lists and notifications: one line, no control characters, ≤ 60 chars. */
export function cleanDeviceName(raw: unknown, fallback: string): string {
  const s = typeof raw === 'string' ? raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim() : ''
  return [...(s || fallback)].slice(0, 60).join('')
}

const WHERE: Record<Listener, string> = { loopback: 'this PC', lan: 'your local network', tailnet: 'Tailscale' }

export function createAccessAuth(ctx: ServerContext, deps: AuthDeps = {}): AccessAuth {
  const log: Log = ctx.log.child('auth')
  const store: PasswordStore = createPasswordStore(ctx.paths.roaming, log)
  const params = deps.scrypt ?? SCRYPT_DEFAULT
  const queue = new ScryptQueue(4)
  const limiter = new LoginLimiter(deps.limiter, { suspended: ctx.repos.kv.get<boolean>(SUSPENDED_KV) === true })
  const pairing = new PairingCodes()
  const passwordListeners = new Set<() => void>()
  let audits = 0

  const now = () => ctx.clock.now()

  function audit(event: string, who: Pick<Caller, 'ip'> | null, detail?: Record<string, unknown>): void {
    try {
      ctx.repos.authLog.add({ now: now(), event, ip: who?.ip ?? null, detail: detail ? JSON.stringify(detail).slice(0, 1000) : null })
      if (++audits % 100 === 0) ctx.repos.authLog.prune(AUDIT_KEEP)
    } catch (e) {
      log.warn('audit log write failed', { event, error: e })
    }
  }

  function who2detail(w: Caller, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...extra, listener: w.listener, ua: w.userAgent?.slice(0, 160) ?? null, ...(w.proxyUser ? { proxyUser: w.proxyUser.slice(0, 120) } : {}) }
  }

  /** Desktop-facing alerts (07 B16): a native notification plus a WS `notify` the desktop UI turns into a toast. */
  function notifyDesktop(title: string, body: string, deviceId?: string): void {
    try {
      ctx.platform.notify(title, body)
    } catch (e) {
      log.warn('notification failed', { error: e })
    }
    ctx.hub.broadcast({ t: 'notify', title, body, ...(deviceId ? { deviceId } : {}) }, { desktopOnly: true })
  }

  const devicesChanged = () => ctx.hub.broadcast({ t: 'devices.changed' })

  /** Refuse before any scrypt runs; `kind` selects the per-IP bucket. */
  function gate(kind: LimitKind, w: Caller): void {
    const v = limiter.check(kind, w.ip, w.listener, now())
    if (v.ok) return
    if (v.reason === 'suspended') {
      throw new VesperError('forbidden', {
        message: 'Signing in from other devices is paused after too many wrong passwords. Resume it in Vesper on your PC (Settings → Access & security).'
      })
    }
    throw new VesperError('rate_limited', { retryAfter: v.retryAfterSec, message: `Too many attempts. Try again in ${v.retryAfterSec} s.` })
  }

  /** Book a wrong password: ladder, suspension (+ desktop alert once), audit. */
  function failed(event: string, w: Caller): VesperError {
    const t = now()
    if (limiter.failure(t)) {
      ctx.repos.kv.set(SUSPENDED_KV, true)
      audit('login.suspended', w, who2detail(w))
      notifyDesktop('Vesper paused remote sign-in', 'There were too many wrong passwords. Sign-in from other devices stays off until you resume it in Settings → Access & security.')
    }
    audit(event, w, who2detail(w))
    const until = limiter.lockedUntil(t)
    return new VesperError('unauthorized', until ? { retryAfter: Math.ceil((until - t) / 1000) } : {})
  }

  async function check(password: string): Promise<boolean> {
    return queue.run(() => verifyPassword(password, store.hash()))
  }

  function sweepPending(): void {
    const t = now()
    for (const d of ctx.repos.devices.list()) {
      if (d.pending && d.revokedUtc === null && t - d.createdUtc > PENDING_TTL_MS) {
        coreOf(ctx).auth.revoke(d.id)
        audit('device.expired', null, { device: d.id, name: d.name })
      }
    }
  }

  const auth: AccessAuth = {
    passwordSet: () => store.isSet(),

    state() {
      const t = now()
      const core = coreOf(ctx)
      return {
        passwordSet: store.isSet(),
        pairingAvailable: ctx.platform.isDesktop || pairing.active(t) > 0,
        setupComplete: ctx.settings.get().wizard.completed,
        version: core.version,
        lockedUntilUtc: limiter.lockedUntil(t),
        isTest: __VESPER_TEST__ && ctx.platform.isTest
      }
    },

    async login(password, deviceName, w, previous) {
      gate('password', w)
      if (!store.isSet()) {
        // Same cost as a real check, so "is a password set?" can't be timed (it is public in /api/auth/state anyway).
        await check(typeof password === 'string' ? password : '')
        throw new VesperError('unauthorized', { message: 'No password is set yet. Set one in Vesper on your PC (Settings → Access & security).' })
      }
      if (!(await check(password))) throw failed('login.fail', w)
      limiter.success()
      const core = coreOf(ctx)
      // Signing in again from the same browser replaces its old device instead of piling up entries.
      if (previous && previous.kind !== 'desktop') core.auth.revoke(previous.deviceId)
      const name = cleanDeviceName(deviceName, 'Browser')
      const r = core.auth.createDevice({ kind: 'browser', listener: w.listener, name, ip: w.ip, userAgent: w.userAgent?.slice(0, 300) ?? null })
      // The password was just entered, so sudo routes work for the next 10 minutes (07 B2).
      ctx.repos.devices.setSudo(r.deviceId, now() + SUDO_MS)
      audit('login.ok', w, who2detail(w, { device: r.deviceId, name }))
      notifyDesktop('New sign-in to Vesper', `"${name}" signed in from ${WHERE[w.listener]}. If this wasn't you, revoke it in Settings → Access & security.`, r.deviceId)
      devicesChanged()
      return r
    },

    async sudo(me, password, w) {
      const t = now()
      if (me.isDesktop) return t + SUDO_MS
      gate('password', w)
      if (!(await check(password))) throw failed('sudo.fail', w)
      limiter.success()
      const until = now() + SUDO_MS
      ctx.repos.devices.setSudo(me.deviceId, until)
      audit('sudo.ok', w, who2detail(w, { device: me.deviceId }))
      return until
    },

    async setPassword(me, body, w) {
      const problem = passwordProblem(body.next)
      if (problem) throw new VesperError('validation', { message: problem, fields: { next: problem } })
      const wasSet = store.isSet()
      if (!me.isDesktop) {
        if (!wasSet) throw new VesperError('desktop_only', { message: 'Set the first password in Vesper on your PC.' })
        if (typeof body.current !== 'string' || !body.current) throw new VesperError('validation', { fields: { current: 'Enter your current password.' } })
        gate('password', w)
        if (!(await check(body.current))) {
          failed('password.fail', w)
          throw new VesperError('validation', { message: 'That is not the current password.', fields: { current: 'That is not the current password.' } })
        }
        limiter.success()
      }
      const hash = await queue.run(() => hashPassword(body.next, params))
      await store.write(hash, now())
      audit(wasSet ? 'password.change' : 'password.set', w, who2detail(w, { device: me.deviceId }))
      // 07 B15: a change revokes every other session (and closes its sockets). The desktop window keeps its session:
      // it is bound to this PC's loopback listener and was minted at launch, not by a password.
      const core = coreOf(ctx)
      for (const d of ctx.repos.devices.list()) {
        if (d.revokedUtc === null && d.id !== me.deviceId && d.kind !== 'desktop') core.auth.revoke(d.id)
      }
      if (!me.isDesktop) ctx.repos.devices.setSudo(me.deviceId, now() + SUDO_MS)
      devicesChanged()
      for (const fn of passwordListeners) {
        try {
          fn()
        } catch (e) {
          log.warn('password listener failed', { error: e })
        }
      }
    },

    createPairing(target) {
      const r = pairing.create(now(), target)
      audit('pair.create', null, { target })
      return r
    },

    redeemPairing(code, deviceName, w, previous) {
      gate('pair', w)
      const target = pairing.redeem(code, w.listener, now())
      if (!target) {
        audit('pair.fail', w, who2detail(w))
        throw new VesperError('unauthorized', { message: 'This pairing code is not valid. Create a new one in Vesper on your PC.' })
      }
      // A 'local' code is minted by the desktop's own "Open in browser" and only works on this PC: no second approval.
      const pending = target !== 'local'
      const name = cleanDeviceName(deviceName, 'New device')
      const core = coreOf(ctx)
      // This browser's cookie is about to be replaced, so its earlier device could never be used again: revoke it
      // rather than leave a live, orphaned row (F12; login() does the same).
      if (previous && previous.kind !== 'desktop') core.auth.revoke(previous.deviceId)
      const r = core.auth.createDevice(
{ kind: 'paired', listener: w.listener, name, pending, ip: w.ip, userAgent: w.userAgent?.slice(0, 300) ?? null })
      audit('pair.redeem', w, who2detail(w, { device: r.deviceId, name, pending }))
      if (pending) {
        ctx.hub.broadcast({ t: 'device.pending', deviceId: r.deviceId, name, ip: w.ip }, { desktopOnly: true })
        notifyDesktop('Allow a new device?', `"${name}" wants to use Vesper from ${WHERE[w.listener]}. Open Vesper to allow or deny it.`, r.deviceId)
      }
      devicesChanged()
      return { ...r, pending }
    },

    approve(deviceId, allow) {
      sweepPending()
      const d = ctx.repos.devices.byId(deviceId)
      if (!d || d.revokedUtc !== null) throw new VesperError('not_found')
      if (!d.pending) throw new VesperError('conflict', { message: 'This device was already approved.' })
      if (allow) ctx.repos.devices.approve(deviceId)
      else coreOf(ctx).auth.revoke(deviceId)
      audit(allow ? 'device.approve' : 'device.deny', null, { device: deviceId, name: d.name })
      devicesChanged()
    },

    revokeDevice(deviceId, me, w) {
      const d = ctx.repos.devices.byId(deviceId)
      if (!d || d.revokedUtc !== null) throw new VesperError('not_found')
      if (d.kind === 'desktop') throw new VesperError('forbidden', { message: "The Vesper app on your PC can't be signed out from here." })
      coreOf(ctx).auth.revoke(deviceId)
      audit('device.revoke', w, who2detail(w, { device: deviceId, name: d.name, by: me.deviceId }))
      devicesChanged()
    },

    devices(me) {
      sweepPending()
      return ctx.repos.devices
        .list()
        .filter((d) => d.revokedUtc === null)
        .map((d) => ({ ...d, current: d.id === me.deviceId }))
    },

    sweepPending,

    log: (limit) => ctx.repos.authLog.list(Math.min(500, Math.max(1, Math.floor(limit)))),

    audit,

    loginSuspended: () => limiter.isSuspended(),

    resumeRemoteLogin() {
      if (!limiter.isSuspended()) return
      limiter.resume()
      ctx.repos.kv.delete(SUSPENDED_KV)
      audit('login.resumed', null)
    },

    onPasswordChanged(fn) {
      passwordListeners.add(fn)
      return () => passwordListeners.delete(fn)
    },

    stats: () => ({ limiterBuckets: limiter.size(), pairingCodes: pairing.active(now()), scryptQueue: queue.size() })
  }
  return auth
}
