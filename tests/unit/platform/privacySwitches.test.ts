/**
 * Phase 4b F21: privacy switches that did nothing. Now:
 *  - reply notifications (07 B17): a finished reply while no desktop window is visible and focused shows a PC
 *    notification; it carries message text only with "Show message text in notifications" on, never for a temporary
 *    chat; "Notify when a reply finishes in the background" off → none;
 *  - diagnostic logging (07 B10): message text reaches the local log only while the switch is on (never a temporary
 *    chat's), and the switch turns itself off 24 hours after it was turned on (timer and at start);
 *  - the tray's mic dot (07 B17): drawn over the icon, with the streaming devices in the tooltip.
 * @R20 @R21
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Message } from '@shared/types/domain'
import { WS_PROTOCOL } from '@shared/ws'
import { systemOf } from '@server/system'
import { DIAG_SINCE_KV, DIAGNOSTIC_TTL_MS, previewText } from '@server/system/replies'
import { trayTooltip, withMicDot } from '../../../src/main/trayModel'
import { coreOf, startTestServer, WsProbe, wsUrl, type TestServer } from '../server/helpers'

let t: TestServer
let desktop = ''
const notes: { title: string; body: string }[] = []

beforeAll(async () => {
  t = await startTestServer({
    platform: (p) => {
      p.isDesktop = true
      p.notify = (title, body) => void notes.push({ title, body })
      return p
    }
  })
  desktop = await t.login('desktop')
})
afterAll(async () => {
  await t?.close()
})

function reply(sessionUid: string, body: string, status: Message['status'] = 'complete'): Message {
  return { uid: `m_${Math.random().toString(36).slice(2)}`, sessionUid, seq: 2, role: 'assistant', tag: 'reply' as Message['tag'], body, tsUtc: Date.now(), tzOffsetMin: 0, tzName: null, device: null, status, attachments: [] }
}

function emitDone(uid: string, m: Message): void {
  t.server.ctx.hub.emit(uid, { t: 'reply.done', sessionUid: uid, replyId: 'r1', message: m })
}

async function session(o: { title: string; temporary?: boolean }): Promise<string> {
  const r = await t.inject({ method: 'POST', url: '/api/sessions', cookie: desktop, payload: { title: o.title, ...(o.temporary ? { temporary: true } : {}) } })
  expect(r.statusCode).toBe(200)
  return (r.json() as { uid: string }).uid
}

async function patch(body: Record<string, unknown>): Promise<void> {
  const r = await t.inject({ method: 'PATCH', url: '/api/settings', cookie: desktop, payload: body })
  expect(r.statusCode).toBe(200)
}

describe('reply notifications', () => {
  it('in the background: "A reply is ready." without text by default; previews show title + plain text; temporary never', async () => {
    const uid = await session({ title: 'Dentist questions' })
    notes.length = 0
    emitDone(uid, reply(uid, '**Bring** your _insurance_ card and [the form](https://x.example).'))
    expect(notes).toEqual([{ title: 'Vesper', body: 'A reply is ready.' }])

    await patch({ chat: { notificationPreviews: true } })
    emitDone(uid, reply(uid, '**Bring** your _insurance_ card and [the form](https://x.example).'))
    expect(notes[1]).toEqual({ title: 'Dentist questions', body: 'Bring your insurance card and the form.' })

    const temp = await session({ title: 'Secret', temporary: true })
    emitDone(temp, reply(temp, 'private words'))
    expect(notes[2]).toEqual({ title: 'Vesper', body: 'A reply is ready.' })

    // Stopped or failed replies, and empty ones, are not announced.
    emitDone(uid, reply(uid, 'half', 'stopped'))
    emitDone(uid, reply(uid, '   '))
    expect(notes).toHaveLength(3)

    await patch({ chat: { notifyWhenHidden: false } })
    emitDone(uid, reply(uid, 'quiet'))
    expect(notes).toHaveLength(3)
    await patch({ chat: { notifyWhenHidden: true, notificationPreviews: false } })
  })

  it('a visible, focused desktop window sees the reply: no notification; a hidden one gets it', async () => {
    const uid = await session({ title: 'Watched' })
    notes.length = 0
    const ws = new WsProbe(wsUrl(t), { host: t.host, origin: t.origin, cookie: desktop })
    await ws.hello()
    try {
      emitDone(uid, reply(uid, 'seen live'))
      expect(notes).toEqual([])
    } finally {
      ws.close()
    }
    const hidden = new WsProbe(wsUrl(t), { host: t.host, origin: t.origin, cookie: desktop })
    await new Promise<void>((r) => hidden.ws.once('open', () => r()))
    hidden.send({ t: 'hello', protocol: WS_PROTOCOL, tz: 'UTC', tzOffset: 0, client: { visible: false, focused: false, audioUnlocked: false } })
    await hidden.next('ready')
    try {
      await new Promise((r) => setTimeout(r, 50))
      emitDone(uid, reply(uid, 'in the tray'))
      expect(notes).toEqual([{ title: 'Vesper', body: 'A reply is ready.' }])
    } finally {
      hidden.close()
    }
  })

  it('previews are plain one-liners', () => {
    expect(previewText('# Title\n\n- one\n- two\n\n```js\ncode()\n```\n`x` done')).toBe('Title one two [code] x done')
    expect(previewText('a'.repeat(400))).toHaveLength(180)
  })
})

describe('diagnostic logging', () => {
  const logText = () => fs.readFileSync(path.join(t.server.ctx.paths.logs, 'vesper.log'), 'utf8')

  it('message text reaches the log only while on (never a temporary chat), and the switch turns itself off after 24 h', async () => {
    const ctx = t.server.ctx
    const sys = systemOf(ctx)!
    const uid = await session({ title: 'Diag' })
    emitDone(uid, reply(uid, 'canary-before-diag-7731'))
    expect(logText()).not.toContain('canary-before-diag-7731')

    await patch({ data: { diagnosticLogging: true } })
    expect(typeof ctx.repos.kv.get(DIAG_SINCE_KV)).toBe('number')
    expect(sys.replies.stats().diagnosticTimer).toBe(true)
    emitDone(uid, reply(uid, 'canary-during-diag-7732'))
    const temp = await session({ title: 'T', temporary: true })
    emitDone(temp, reply(temp, 'canary-temporary-7733'))
    const log = logText()
    expect(log).toContain('canary-during-diag-7732')
    expect(log).not.toContain('canary-temporary-7733')

    // 24 hours later the timer turns it off (the clock is moved; the private handler is what the timer calls).
    coreOf(ctx).clockOffsetMs = DIAGNOSTIC_TTL_MS + 1000
    try {
      await (sys.replies as unknown as { turnDiagnosticsOff(): Promise<void> }).turnDiagnosticsOff()
    } finally {
      coreOf(ctx).clockOffsetMs = 0
    }
    expect(ctx.settings.get().data.diagnosticLogging).toBe(false)
    expect(ctx.repos.kv.get(DIAG_SINCE_KV)).toBeNull()
    expect(sys.replies.stats().diagnosticTimer).toBe(false)
    emitDone(uid, reply(uid, 'canary-after-diag-7734'))
    expect(logText()).not.toContain('canary-after-diag-7734')
  })

  it('at start: a switch that has been on for more than 24 hours is turned off', async () => {
    const ctx = t.server.ctx
    const sys = systemOf(ctx)!
    await patch({ data: { diagnosticLogging: true } })
    ctx.repos.kv.set(DIAG_SINCE_KV, ctx.clock.now() - DIAGNOSTIC_TTL_MS - 1)
    ;(sys.replies as unknown as { diagnosticsChanged(): void }).diagnosticsChanged()
    await expect.poll(() => ctx.settings.get().data.diagnosticLogging).toBe(false)
  })
})

describe('tray mic dot', () => {
  it('a red dot in the lower-right corner, the rest of the icon untouched; the tooltip names the devices', () => {
    const w = 32
    const icon = Buffer.alloc(w * w * 4, 7)
    const dotted = withMicDot(icon, w, w)
    const px = (b: Buffer, x: number, y: number) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)]
    expect(px(dotted, w - 5, w - 5)).toEqual([56, 48, 235, 255])
    expect(px(dotted, 4, 4)).toEqual([7, 7, 7, 7])
    expect(px(icon, w - 5, w - 5)).toEqual([7, 7, 7, 7])
    expect(trayTooltip([])).toBe('Vesper')
    expect(trayTooltip(['Pixel 8', 'Pixel 8', 'Laptop'])).toBe('Vesper — microphone in use: Pixel 8, Laptop')
  })
})
