/**
 * access-ui logic (R1; 07 B15/B16, D8): live password rules agree with the server's, the pairing code is read only
 * from a well-formed fragment, sign-in failures map to the right UI state, the capability matrix matches 07 D8, and
 * the formatting helpers (fingerprint, countdown, audit log) are safe and stable.
 */
import { describe, expect, it } from 'vitest'
import { apiError } from '@shared/errors'
import type { DeviceInfo, NetworkStatus } from '@shared/types/domain'
import { passwordProblem } from '@server/auth/password'
import { COMMON_PASSWORDS } from '@shared/commonPasswords'
import {
  auditDetail,
  auditLabel,
  auditTone,
  CAPABILITIES,
  countdownWords,
  deviceIcon,
  fingerprintLines,
  firewallSwitchNote,
  formatCountdown,
  groupCode,
  hasWarning,
  lanAddressForOthers,
  MODES,
  sortDevices,
  topWarnings,
  warningTone
} from '../../../src/web/features/access/access.logic'
import { checkPassword } from '../../../src/web/features/access/password.logic'
import { guessDeviceName, isThisPcHost, pairCodeFromHash, readSignInError, secondsLeft } from '../../../src/web/features/login/login.logic'

describe('live password rules (07 B15) @R1', () => {
  const samples = [
    '',
    'short',
    'fourteen chars',
    'fifteen chars!!',
    'violin harbor 1987 tide',
    '123456789012345',
    'abcabcabcabcabcabc',
    'qwertyuiopasdfghjkl',
    'aaaaaaaaaaaaaaaaaaaa',
    'zyxwvutsrqponmlkji',
    'ｆｕｌｌｗｉｄｔｈ ｐａｓｓｗｏｒｄ',
    'tab\tinside the password',
    'x'.repeat(1025),
    'correct horse battery staple',
    ...COMMON_PASSWORDS.slice(0, 40),
    ...COMMON_PASSWORDS.slice(0, 10).map((p) => p.toUpperCase())
  ]

  it('accepts and refuses exactly what the server does', () => {
    for (const pw of samples) {
      const client = checkPassword(pw).problem
      const server = passwordProblem(pw)
      expect(client === null, `"${pw.slice(0, 40)}": client=${client} server=${server}`).toBe(server === null)
    }
  })

  it('reports each rule separately for the live checklist', () => {
    expect(checkPassword('violin harbor').longEnough).toBe(false)
    const c = checkPassword('violin harbor 1987 tide')
    expect(c).toMatchObject({ longEnough: true, notCommon: true, notPattern: true, noControl: true, problem: null })
    expect(checkPassword('123456789012345').notPattern).toBe(false)
    expect(checkPassword(COMMON_PASSWORDS[0]).notCommon).toBe(false)
    // NFKC: the count is what the server counts.
    expect(checkPassword('ﬁ'.repeat(8)).chars).toBe(16)
  })
})

describe('pairing code from the URL fragment (research 06 §5.7) @R1', () => {
  it('reads #c= and nothing else', () => {
    expect(pairCodeFromHash('#c=AbC123_-xyzXYZ0987654')).toBe('AbC123_-xyzXYZ0987654')
    expect(pairCodeFromHash('c=AbC123_-xyzXYZ0987654')).toBe('AbC123_-xyzXYZ0987654')
    expect(pairCodeFromHash('#x=1&c=AbC123_-xyzXYZ0987654')).toBe('AbC123_-xyzXYZ0987654')
    expect(pairCodeFromHash('')).toBeNull()
    expect(pairCodeFromHash('#c=')).toBeNull()
    expect(pairCodeFromHash('#c=short')).toBeNull()
    expect(pairCodeFromHash('#c=<script>alert(1)</script>')).toBeNull()
    expect(pairCodeFromHash('#c=%E0%A4%A')).toBeNull()
    expect(pairCodeFromHash('#code=AbC123_-xyzXYZ0987654')).toBeNull()
  })

  it('knows the hosts where "Open in browser" codes need no approval', () => {
    expect(isThisPcHost('vesper.localhost')).toBe(true)
    expect(isThisPcHost('127.0.0.1')).toBe(true)
    expect(isThisPcHost('127.0.0.2')).toBe(false)
    expect(isThisPcHost('pc.tail1234.ts.net')).toBe(false)
  })
})

describe('sign-in failures', () => {
  it('maps the server answers to UI states', () => {
    expect(readSignInError(apiError('unauthorized'), true)).toMatchObject({ kind: 'wrong', message: 'That password is not right.', retryAfterSec: null })
    expect(readSignInError(apiError('unauthorized', { retryAfter: 4.2 }), true)).toMatchObject({ kind: 'wrong', retryAfterSec: 5 })
    expect(readSignInError(apiError('unauthorized', { message: 'No password is set yet.' }), false)).toMatchObject({ kind: 'no-password' })
    expect(readSignInError(apiError('rate_limited', { retryAfter: 37 }), true)).toMatchObject({ kind: 'locked', retryAfterSec: 37 })
    expect(readSignInError(apiError('rate_limited'), true)).toMatchObject({ kind: 'locked', retryAfterSec: 60 })
    expect(readSignInError(apiError('forbidden', { message: 'Signing in from other devices is paused.' }), true)).toMatchObject({ kind: 'suspended' })
    expect(readSignInError(apiError('network'), true).kind).toBe('network')
  })

  it('counts down in whole seconds and never below zero', () => {
    expect(secondsLeft(null, 0)).toBe(0)
    expect(secondsLeft(10_000, 0)).toBe(10)
    expect(secondsLeft(10_000, 9_001)).toBe(1)
    expect(secondsLeft(10_000, 20_000)).toBe(0)
  })

  it('guesses a readable device name', () => {
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Mobile Safari/537.36')).toBe('Chrome on Android')
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone')
    expect(guessDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0 Safari/537.36 Edg/142.0')).toBe('Edge on Windows')
    expect(guessDeviceName('curl/8')).toBe('Browser on this device')
  })
})

describe('capability matrix (07 D8) @R1', () => {
  const cell = (row: string, mode: 'local' | 'lan' | 'tailscale') => CAPABILITIES.find((r) => r.id === row)!.cells[mode].cap
  it('says what works on phones in each mode', () => {
    expect(MODES.map((m) => m.id)).toEqual(['local', 'lan', 'tailscale'])
    expect(cell('home', 'local')).toBe('no')
    expect(cell('home', 'lan')).toBe('yes')
    expect(cell('away', 'lan')).toBe('no')
    expect(cell('away', 'tailscale')).toBe('yes')
    // The mic needs HTTPS: LAN after accepting the certificate, Tailscale always.
    expect(cell('mic', 'lan')).toBe('yes')
    expect(cell('mic', 'tailscale')).toBe('yes')
    // Install on the phone only via Tailscale (trusted certificate).
    expect(cell('install', 'lan')).toBe('no')
    expect(cell('install', 'tailscale')).toBe('yes')
    expect(cell('cert', 'lan')).toBe('no')
  })
})

describe('formatting', () => {
  it('splits a SHA-256 fingerprint into 4 lines of 8 bytes', () => {
    const fp = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(':')
    const lines = fingerprintLines(fp)
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe('00:01:02:03:04:05:06:07')
    expect(lines[3]).toBe('18:19:1A:1B:1C:1D:1E:1F')
    expect(fingerprintLines('not a fingerprint')).toEqual(['not a fingerprint'])
    expect(fingerprintLines(null)).toEqual([])
  })

  it('formats countdowns', () => {
    expect(formatCountdown(300_000)).toBe('5:00')
    expect(formatCountdown(65_001)).toBe('1:06')
    expect(formatCountdown(-5)).toBe('0:00')
    expect(countdownWords(61_000)).toBe('1 minute 1 second')
    expect(countdownWords(120_000)).toBe('2 minutes')
    expect(countdownWords(0)).toBe('0 seconds')
    expect(groupCode('abcdefghij')).toBe('abcd efgh ij')
  })

  it('labels the audit log in words and never shows raw JSON', () => {
    expect(auditLabel('login.fail')).toBe('Wrong password')
    expect(auditLabel('some.new_event')).toBe('some new event')
    expect(auditTone('login.fail')).toBe('danger')
    expect(auditTone('device.revoke')).toBe('warning')
    expect(auditTone('login.ok')).toBe('success')
    expect(auditDetail(JSON.stringify({ name: 'Pixel 9', listener: 'lan', ua: 'x'.repeat(200) }))).toBe('“Pixel 9” · Local network')
    expect(auditDetail(JSON.stringify({ target: 'tailnet' }))).toBe('for Tailscale')
    expect(auditDetail(JSON.stringify({ ok: false, publicToo: true }))).toBe('cancelled or failed')
    expect(auditDetail('{broken')).toBe('')
    expect(auditDetail(null)).toBe('')
  })
})

describe('devices and warnings', () => {
  const d = (over: Partial<DeviceInfo>): DeviceInfo => ({
    id: 'd',
    name: 'n',
    kind: 'browser',
    listener: 'lan',
    createdUtc: 1,
    lastSeenUtc: null,
    lastIp: null,
    userAgent: null,
    current: false,
    pending: false,
    revokedUtc: null,
    ...over
  })

  it('sorts the current device first, then pending, then by last seen', () => {
    const list = sortDevices([d({ id: 'old', lastSeenUtc: 10 }), d({ id: 'new', lastSeenUtc: 50 }), d({ id: 'pend', pending: true }), d({ id: 'me', current: true })])
    expect(list.map((x) => x.id)).toEqual(['me', 'pend', 'new', 'old'])
  })

  it('picks a device picture from the user agent', () => {
    expect(deviceIcon(d({ kind: 'desktop' }))).toBe('desktop')
    expect(deviceIcon(d({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Mobile' }))).toBe('phone')
    expect(deviceIcon(d({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 19_0)' }))).toBe('tablet')
    expect(deviceIcon(d({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }))).toBe('laptop')
  })

  it('keeps warnings explained in place out of the top list', () => {
    const n = {
      warnings: [
        { code: 'firewall_blocked', message: 'a' },
        { code: 'port_unavailable', message: 'b' },
        { code: 'funnel_public', message: 'c' }
      ]
    } as unknown as NetworkStatus
    expect(topWarnings(n).map((w) => w.code)).toEqual(['port_unavailable'])
    expect(hasWarning(n, 'funnel_public')).toBe(true)
    expect(hasWarning(null, 'funnel_public')).toBe(false)
    expect(warningTone('funnel_public')).toBe('danger')
    expect(warningTone('remote_paused')).toBe('info')
    expect(warningTone('firewall_unknown')).toBe('warning')
  })
})

describe('the address other devices type, and what Windows will ask (07 H-v111-firewall) @R1', () => {
  const lan = (o: Partial<NonNullable<NetworkStatus['lan']>>) => ({ running: true, url: 'https://192.168.1.20:41731', urls: ['https://192.168.1.20:41731', 'https://vesper-pc.local:41731'], firewall: 'unknown', ...o })
  const net = (mode: NetworkStatus['mode'], l: object | null) => ({ mode, lan: l, loopback: { browserUrl: 'http://vesper.localhost:41730' } }) as unknown as NetworkStatus

  it('Local network on and running: the LAN panel’s first address (the This PC card shows the same one)', () => {
    expect(lanAddressForOthers(net('lan', lan({})))).toBe('https://192.168.1.20:41731')
    expect(lanAddressForOthers(net('lan', lan({ urls: [] })))).toBe('https://192.168.1.20:41731')
  })

  it('off, not running yet, or another mode: none (the card says how to turn it on instead)', () => {
    expect(lanAddressForOthers(net('local', null))).toBeNull()
    expect(lanAddressForOthers(net('tailscale', null))).toBeNull()
    expect(lanAddressForOthers(net('lan', lan({ running: false, url: null, urls: [] })))).toBeNull()
    expect(lanAddressForOthers(null)).toBeNull()
  })

  it('the apply bar says Windows will ask to add the rule (on) or remove the rules (off), never on loopback', () => {
    expect(firewallSwitchNote('local', 'lan', null)).toMatch(/Windows will ask for permission to add Vesper’s firewall rule/)
    expect(firewallSwitchNote('tailscale', 'lan', null)).toMatch(/add/)
    expect(firewallSwitchNote('lan', 'local', lan({}) as NetworkStatus['lan'])).toBe('Windows will ask for permission to remove Vesper’s firewall rules.')
    expect(firewallSwitchNote('lan', 'tailscale', lan({ firewall: 'allowed' }) as NetworkStatus['lan'])).toMatch(/remove/)
    expect(firewallSwitchNote('lan', 'local', lan({ firewall: 'not-needed' }) as NetworkStatus['lan'])).toBeNull()
    expect(firewallSwitchNote('local', 'tailscale', null)).toBeNull()
    expect(firewallSwitchNote('lan', 'lan', null)).toBeNull()
  })
})
