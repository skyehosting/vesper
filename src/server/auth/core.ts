/**
 * Auth core (07 B2/B4/B11/B16, research 06 §5.2/§5.6): opaque device sessions in the `__Host-vesper_sid` cookie.
 * The token is 32 random bytes (base64url); only its SHA-256 is stored. A desktop session is valid only on Listener A
 * (loopback) and only one exists at a time. Password login, lockout, pairing and device management beyond this core
 * belong to the access-server module, which builds on `createDevice` / `resolve`.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { AuthState, AuthStateBase } from '@shared/api'
import type { DeviceKind, Listener } from '@shared/types/domain'
import { WS_CLOSE } from '@shared/ws'
import type { ServerContext } from '../services'

export const SESSION_COOKIE = '__Host-vesper_sid'
const DAY = 86_400_000
/**
 * Local-browser sessions (any non-desktop device on Listener A: password login or "Open in browser"/local pairing):
 * idle per settings (default 7 d), absolute 30 d (07 B4, F07). LAN/Tailscale devices: absolute 180 d.
 */
export const ABSOLUTE_LOOPBACK_BROWSER = 30 * DAY
export const ABSOLUTE_OTHER = 180 * DAY
const TOUCH_EVERY_MS = 60_000

/** The fields that decide whether a device session is still within its lifetime. */
export interface SessionLifetimeRow {
  kind: DeviceKind
  listener: Listener
  createdUtc: number
  lastSeenUtc: number | null
}

/**
 * Lifetime rules shared by REST (`resolve`) and open WebSockets (`stillValid`), so the two cannot drift (F01).
 * Desktop sessions have no lifetime (they are session-only and replaced at every launch, 07 B11). Every other device
 * is signed out after `idleMs` without activity and after its absolute limit.
 */
export function sessionExpired(d: SessionLifetimeRow, now: number, idleMs: number): boolean {
  if (d.kind === 'desktop') return false
  return now - (d.lastSeenUtc ?? d.createdUtc) > idleMs || now - d.createdUtc > absoluteLimit(d)
}

/**
 * Absolute session limit for a non-desktop device (07 B4). It depends on where the device signed in, not on how: a
 * browser paired through a 'local' code (Open in browser) is as much a local browser as a password login (F07).
 */
export function absoluteLimit(d: Pick<SessionLifetimeRow, 'listener'>): number {
  return d.listener === 'loopback' ? ABSOLUTE_LOOPBACK_BROWSER : ABSOLUTE_OTHER
}

export interface RequestAuth {
  deviceId: string
  name: string
  kind: DeviceKind
  /** The listener the device was created on. */
  deviceListener: Listener
  /** The listener this request arrived on. */
  listener: Listener
  pending: boolean
  /** Desktop device on Listener A (07 B2 'desktop'). */
  isDesktop: boolean
  /** Desktop, or password re-entered within the sudo window (07 B2 'sudo'). */
  sudo: boolean
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newDeviceId(): string {
  return `dev_${randomBytes(9).toString('base64url')}`
}

/** Parse a Cookie header without trusting it (first occurrence wins, values not decoded beyond %XX). */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() !== name) continue
    const v = part.slice(i + 1).trim()
    return v || null
  }
  return null
}

/**
 * Set-Cookie value. Desktop cookies are session-only (07 B11); browsers keep theirs for the device's absolute limit
 * (`maxAgeMs`, see absoluteLimit — the server enforces expiry either way).
 */
export function sessionCookie(token: string, persistent: boolean, maxAgeMs = ABSOLUTE_OTHER): string {
  const base = `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`
  return persistent ? `${base}; Max-Age=${Math.floor(maxAgeMs / 1000)}` : base
}

export function clearedCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

export interface AuthCore {
  /** The device behind a Cookie header on `listener`, or null (no/unknown/revoked/expired session). */
  resolve(cookieHeader: string | undefined, listener: Listener, ip: string | null): RequestAuth | null
  /**
   * Re-validation of an already authenticated connection (an open WebSocket, F01): the device exists, is approved, not
   * revoked and still within its idle and absolute lifetime — the same rules as `resolve`.
   */
  stillValid(deviceId: string): boolean
  /**
   * Activity on an authenticated connection counts as 'seen' for the idle limit (throttled like `resolve`). Like
   * `resolve`, it checks the session first: a revoked, pending or expired session is never refreshed (activity that
   * arrives after the idle limit must not bring it back). Returns whether the session is still valid.
   */
  touch(deviceId: string, ip: string | null): boolean
  /** Register a device session; returns the raw token for the cookie (never stored). */
  createDevice(d: { kind: DeviceKind; listener: Listener; name: string; pending?: boolean; ip?: string | null; userAgent?: string | null }): {
    deviceId: string
    token: string
  }
  /** 07 B11: revoke earlier desktop devices (closing their sockets) and mint a fresh desktop session. */
  createDesktopSession(): { deviceId: string; token: string }
  revoke(deviceId: string): void
  /** Replaceable by access-server (password, pairing, lockout state). */
  setStateProvider(fn: () => AuthState): void
  state(): AuthStateBase
}

export function createAuthCore(ctx: ServerContext, o: { version: string; passwordSet: () => boolean }): AuthCore {
  const lastTouch = new Map<string, number>()
  let stateProvider: (() => AuthState) | null = null
  const lifetimeStmt = ctx.db.prepare('SELECT kind, listener, pending, revoked_utc, created_utc, last_seen_utc FROM devices WHERE id = ?')
  const idleMs = () => ctx.settings.get().access.idleTimeoutDays * DAY
  /** Exists, not revoked, approved, and within its idle and absolute lifetime at `now`. */
  const lifetimeOk = (deviceId: string, now: number): boolean => {
    const r = lifetimeStmt.get(deviceId) as
      | { kind: DeviceKind; listener: Listener; pending: number; revoked_utc: number | null; created_utc: number; last_seen_utc: number | null }
      | undefined
    if (!r || r.revoked_utc !== null || Number(r.pending) !== 0) return false
    const row: SessionLifetimeRow = {
      kind: r.kind,
      listener: r.listener,
      createdUtc: Number(r.created_utc),
      lastSeenUtc: r.last_seen_utc === null ? null : Number(r.last_seen_utc)
    }
    return !sessionExpired(row, now, idleMs())
  }
  const touch = (deviceId: string, now: number, ip: string | null) => {
    if (now - (lastTouch.get(deviceId) ?? 0) <= TOUCH_EVERY_MS) return
    lastTouch.set(deviceId, now)
    ctx.repos.devices.touch(deviceId, now, ip)
  }

  const core: AuthCore = {
    resolve(cookieHeader, listener, ip) {
      const token = readCookie(cookieHeader, SESSION_COOKIE)
      if (!token || token.length > 128) return null
      const d = ctx.repos.devices.byTokenHash(hashToken(token))
      if (!d || d.revokedUtc !== null) return null
      const now = ctx.clock.now()
      if (d.kind === 'desktop') {
        if (listener !== 'loopback' || d.listener !== 'loopback') return null
      } else if (sessionExpired(d, now, idleMs())) return null
      touch(d.id, now, ip)
      const isDesktop = d.kind === 'desktop' && listener === 'loopback'
      return {
        deviceId: d.id,
        name: d.name,
        kind: d.kind,
        deviceListener: d.listener,
        listener,
        pending: d.pending,
        isDesktop,
        sudo: isDesktop || (d.sudoUntilUtc !== null && d.sudoUntilUtc > now)
      }
    },
    stillValid(deviceId) {
      return lifetimeOk(deviceId, ctx.clock.now())
    },
    touch(deviceId, ip) {
      const now = ctx.clock.now()
      if (!lifetimeOk(deviceId, now)) return false
      touch(deviceId, now, ip)
      return true
    },
    createDevice(d) {
      const token = newToken()
      const deviceId = newDeviceId()
      ctx.repos.devices.create({
        id: deviceId,
        name: d.name,
        kind: d.kind,
        listener: d.listener,
        tokenHash: hashToken(token),
        pending: d.pending ?? false,
        now: ctx.clock.now(),
        ip: d.ip ?? null,
        userAgent: d.userAgent ?? null
      })
      return { deviceId, token }
    },
    createDesktopSession() {
      const now = ctx.clock.now()
      const earlier = ctx.repos.devices.list().filter((x) => x.kind === 'desktop' && x.revokedUtc === null)
      ctx.repos.devices.revokeKind('desktop', now)
      for (const x of earlier) ctx.hub.closeDevice(x.id, WS_CLOSE.replaced, 'replaced')
      const r = core.createDevice({ kind: 'desktop', listener: 'loopback', name: 'Vesper app' })
      ctx.repos.authLog.add({ now, event: 'desktop.session', ip: null, detail: null })
      return r
    },
    revoke(deviceId) {
      ctx.repos.devices.revoke(deviceId, ctx.clock.now())
      lastTouch.delete(deviceId)
      ctx.hub.closeDevice(deviceId, WS_CLOSE.auth, 'revoked')
    },
    setStateProvider(fn) {
      stateProvider = fn
    },
    state() {
      if (stateProvider) return stateProvider()
      return {
        passwordSet: o.passwordSet(),
        pairingAvailable: false,
        setupComplete: ctx.settings.get().wizard.completed,
        version: o.version,
        lockedUntilUtc: null,
        isTest: __VESPER_TEST__ && ctx.platform.isTest
      }
    }
  }
  return core
}
