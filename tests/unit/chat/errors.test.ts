/**
 * Chat-turn failure modes (07 C19, D13; Phase 4c fix-chat-engine): internal errors are never presented as provider
 * rejections (F61), a reply that cannot be saved still ends the turn with a clear disk message and is retried (F28/F58),
 * provider 500 vs busy (F54), empty or cut-off answers are reported (F63) and the catalogue promises only what the
 * engine does (F68).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { coreOf } from '@server/core'
import { purgeOnMainThread } from '@server/http/sessions'
import { mapProviderError } from '@server/providers/llm/errors'
import type { ServerMsg } from '@shared/ws'
import { ChatHarness, chatRequests, waitMsg } from './harness'
import type { WsProbe } from '../server/helpers'

let h: ChatHarness

beforeAll(async () => {
  // The 30 s "not saved" retry (07 C19), shortened for tests.
  process.env.VESPER_CHAT_SAVE_RETRY_MS = '100'
  h = await ChatHarness.start()
})
afterAll(() => h.close())
beforeEach(async () => {
  h.mock.reset()
  h.ctx.services.speech = undefined
  h.ctx.services.memory = undefined
  await h.ctx.settings.patch({ chat: { autoTitle: false } })
  await h.setProfile(h.openaiProfile())
})

type Repos = ReturnType<typeof coreOf>['repos']
const repos = (): Repos => coreOf(h.ctx).repos

async function fresh(): Promise<{ uid: string; p: WsProbe }> {
  const s = await h.session()
  return { uid: s.uid, p: await h.client(s.uid) }
}

/** Replace one repo method until the returned restore() is called. */
function patch<K extends keyof Repos, M extends keyof Repos[K]>(repo: K, method: M, impl: (orig: Repos[K][M], ...args: unknown[]) => unknown): () => void {
  const r = repos()[repo] as Record<string, unknown>
  const orig = r[method as string] as (...a: unknown[]) => unknown
  r[method as string] = (...args: unknown[]) => impl(orig.bind(r) as Repos[K][M], ...args)
  return () => {
    r[method as string] = orig
  }
}

function sendRaw(p: WsProbe, uid: string, id: string, text: string): void {
  p.send({ t: 'chat.send', id, sessionUid: uid, text, attachments: [], client: { ts: Date.now(), tzOffset: 0, tzName: null }, speak: false })
}

async function errorOf(p: WsProbe): Promise<Extract<ServerMsg, { t: 'reply.error' }>['error']> {
  const e = (await waitMsg(p, (m) => m.t === 'reply.error')) as Extract<ServerMsg, { t: 'reply.error' }>
  await waitMsg(p, (m) => m.t === 'reply.done')
  return e.error
}

const sqliteError = (message: string, errcode: number): Error => Object.assign(new Error(message), { code: 'ERR_SQLITE_ERROR', errcode })

describe('internal errors are not provider rejections (F61)', () => {
  it('a bug (TypeError) in a turn is "internal", retryable, not "The AI service rejected the request"', async () => {
    const { uid, p } = await fresh()
    const restore = patch('transcript', 'forEpoch', () => {
      throw new TypeError("Cannot read properties of undefined (reading 'blocks')")
    })
    try {
      sendRaw(p, uid, 'f61a', 'hello')
      const err = await errorOf(p)
      expect(err).toMatchObject({ code: 'internal', retryable: true })
    } finally {
      restore()
    }
  })

  it('a busy database outside the retried writes is a retryable db_error (07 H1)', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'first')
    const restore = patch('epochs', 'current', () => {
      throw sqliteError('database is locked', 5)
    })
    try {
      sendRaw(p, uid, 'f61b', 'second')
      expect(await errorOf(p)).toMatchObject({ code: 'db_error', retryable: true })
    } finally {
      restore()
    }
  })

  it('a SQL error is not shown as a provider error', async () => {
    const { uid, p } = await fresh()
    const restore = patch('transcript', 'forEpoch', () => {
      throw sqliteError('no such table: transcript', 1)
    })
    try {
      sendRaw(p, uid, 'f61c', 'hello')
      const err = await errorOf(p)
      expect(err.code).not.toMatch(/^provider_/)
    } finally {
      restore()
    }
  })

  it('a provider stream Vesper cannot parse says so (not "rejected the request")', () => {
    const e = mapProviderError(new SyntaxError('Unexpected token < in JSON at position 0'))
    expect(e.info.code).toBe('provider_bad_request')
    expect(e.info.message).toMatch(/couldn.t read/i)
    expect(e.info.retryable).toBe(true)
  })

  it('upstream errors still map to provider codes', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ error: { status: 401 } })
    sendRaw(p, uid, 'f61d', 'hi')
    expect(await errorOf(p)).toMatchObject({ code: 'provider_auth' })
    expect(chatRequests(h.mock)).toHaveLength(1)
  })
})

describe('a reply that cannot be saved (F28/F58, 07 C19 SQLITE_FULL)', () => {
  const diskFull = (): Error => sqliteError('database or disk is full', 13)

  it('still ends the turn: reply.error disk_full + reply.done with the text; saved by the retry once space is back', async () => {
    const { uid, p } = await fresh()
    let full = true
    let attempts = 0
    const restore = patch('messages', 'update', (orig, id, pch) => {
      if ((pch as { status?: string }).status !== undefined && full) {
        attempts++
        throw diskFull()
      }
      return (orig as (...a: unknown[]) => unknown)(id, pch)
    })
    try {
      sendRaw(p, uid, 'f28a', 'a long answer please')
      const err = (await waitMsg(p, (m) => m.t === 'reply.error')) as Extract<ServerMsg, { t: 'reply.error' }>
      expect(err.error).toMatchObject({ code: 'disk_full' })
      expect(err.error.message).toMatch(/isn.t saved/i)
      const done = (await waitMsg(p, (m) => m.t === 'reply.done')) as Extract<ServerMsg, { t: 'reply.done' }>
      expect(done.message).toMatchObject({ body: 'Echo: a long answer please', status: 'error', error: { code: 'disk_full' } })
      expect(h.engine.busy(uid)).toBe(false)
      expect(attempts).toBeGreaterThan(0)
      // Space comes back: the 30 s retry (shortened in tests) saves the full reply as it was meant to be.
      full = false
      const upd = (await waitMsg(p, (m) => m.t === 'message.updated' && m.message.uid === done.message.uid, 5000)) as Extract<ServerMsg, { t: 'message.updated' }>
      expect(upd.message).toMatchObject({ body: 'Echo: a long answer please', status: 'complete' })
      expect(upd.message.error).toBeUndefined()
      const row = repos().messages.byUid(done.message.uid)!
      expect(row).toMatchObject({ status: 'complete', body: 'Echo: a long answer please', error: null })
      expect(h.engine.stats().pendingSaves).toBe(0)
    } finally {
      restore()
    }
  })

  it('a reload / reconnect / second device sees the same "not saved" row as reply.done, until the retry lands', async () => {
    const { uid, p } = await fresh()
    let full = true
    const restore = patch('messages', 'update', (orig, id, pch) => {
      if ((pch as { status?: string }).status !== undefined && full) throw diskFull()
      return (orig as (...a: unknown[]) => unknown)(id, pch)
    })
    type Page = { items: { uid: string; role: string; status: string; body: string; error?: { code: string } }[] }
    const latest = async (): Promise<Page['items']> => ((await h.inject('GET', `/api/sessions/${uid}/messages?mode=latest`)).json() as Page).items
    try {
      sendRaw(p, uid, 'f28c', 'remember this')
      const done = (await waitMsg(p, (m) => m.t === 'reply.done')) as Extract<ServerMsg, { t: 'reply.done' }>
      const last = (await latest()).at(-1)!
      expect(last).toMatchObject({ uid: done.message.uid, role: 'assistant', status: 'error', body: 'Echo: remember this', error: { code: 'disk_full' } })
      full = false
      await waitMsg(p, (m) => m.t === 'message.updated' && m.message.uid === done.message.uid, 5000)
      const saved = (await latest()).at(-1)!
      expect(saved).toMatchObject({ status: 'complete', body: 'Echo: remember this' })
      expect(saved.error).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('a pending save whose message is gone (trash emptied) is dropped, not retried forever', async () => {
    const { uid, p } = await fresh()
    const restore = patch('messages', 'update', (orig, id, pch) => {
      if ((pch as { status?: string }).status !== undefined) throw diskFull()
      return (orig as (...a: unknown[]) => unknown)(id, pch)
    })
    try {
      sendRaw(p, uid, 'f28d', 'hello')
      await errorOf(p)
      expect(h.engine.stats().pendingSaves).toBe(1)
      const s = repos().sessions.byUid(uid)!
      purgeOnMainThread(h.ctx, [s.id])
      expect(repos().sessions.byUid(uid)).toBeFalsy()
      const until = Date.now() + 3000
      while (h.engine.stats().pendingSaves > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      expect(h.engine.stats().pendingSaves).toBe(0)
    } finally {
      restore()
    }
  })

  it('a transcript row that cannot be written ends the turn with disk_full (never a stuck streaming row)', async () => {
    const { uid, p } = await fresh()
    const restore = patch('transcript', 'append', (orig, row) => {
      if ((row as { role?: string }).role === 'assistant') throw diskFull()
      return (orig as (...a: unknown[]) => unknown)(row)
    })
    try {
      sendRaw(p, uid, 'f28b', 'hello')
      expect(await errorOf(p)).toMatchObject({ code: 'disk_full' })
    } finally {
      restore()
    }
    const s = repos().sessions.byUid(uid)!
    expect(repos().messages.tail(s.id, 1)[0].status).not.toBe('streaming')
  })
})

describe('a real full database (PRAGMA max_page_count) during a long reply (F58)', () => {
  it('the turn ends with disk_full and the reply is saved once space is back', async () => {
    const { uid, p } = await fresh()
    const long = 'x'.repeat(2000)
    h.mock.llm.script({ text: Array.from({ length: 60 }, (_, i) => `${i} ${long}`).join('\n'), chunkChars: 4000, delayMs: 10 })
    sendRaw(p, uid, 'f58', 'write a lot')
    await waitMsg(p, (m) => m.t === 'reply.delta')
    const pages = (h.ctx.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    h.ctx.db.exec(`PRAGMA max_page_count = ${Number(pages)}`)
    try {
      const err = (await waitMsg(p, (m) => m.t === 'reply.error')) as Extract<ServerMsg, { t: 'reply.error' }>
      expect(err.error.code).toBe('disk_full')
      const done = (await waitMsg(p, (m) => m.t === 'reply.done')) as Extract<ServerMsg, { t: 'reply.done' }>
      expect(done.message.body.length).toBeGreaterThan(100_000)
      h.ctx.db.exec('PRAGMA max_page_count = 1073741823')
      const upd = (await waitMsg(p, (m) => m.t === 'message.updated' && m.message.uid === done.message.uid, 5000)) as Extract<ServerMsg, { t: 'message.updated' }>
      expect(upd.message.body).toBe(done.message.body)
      expect(repos().messages.byUid(done.message.uid)!.body.length).toBe(done.message.body.length)
    } finally {
      h.ctx.db.exec('PRAGMA max_page_count = 1073741823')
    }
  })
})

describe('provider 500 vs busy (F54)', () => {
  it('a 500 is "had an internal error (HTTP 500)" after one automatic retry, with Fix in Settings and Try again', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ error: { status: 500, message: 'model requires more system memory' } }, { error: { status: 500 } })
    sendRaw(p, uid, 'f54a', 'hi')
    const err = await errorOf(p)
    expect(err).toMatchObject({ code: 'provider_error', retryable: true, upstreamStatus: 500 })
    expect(err.message).toMatch(/internal error \(HTTP 500\)/)
    expect(err.message).not.toMatch(/busy/i)
    expect(JSON.stringify(err)).not.toContain('system memory')
    expect(chatRequests(h.mock)).toHaveLength(2)
  })

  it('a 503 is still "busy right now"', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ error: { status: 503 } }, { error: { status: 503 } })
    sendRaw(p, uid, 'f54b', 'hi')
    expect(await errorOf(p)).toMatchObject({ code: 'provider_overloaded', message: 'The AI service is busy right now.' })
  })

  // F54 second pass: OpenRouter / vLLM end a stream with finish_reason "error" for an internal failure mid-generation.
  it('a stream that ends with finish_reason "error" is an internal error after one automatic retry, not "busy"', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: '', stopReason: 'error' }, { text: '', stopReason: 'error' })
    sendRaw(p, uid, 'f54c', 'hi')
    const err = await errorOf(p)
    expect(err).toMatchObject({ code: 'provider_error', retryable: true })
    expect(err.message).not.toMatch(/busy/i)
    expect(chatRequests(h.mock)).toHaveLength(2)
  })

  it('finish_reason "error" before any text is retried once and the retry answers', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: '', stopReason: 'error' }, { text: 'second try' })
    const t = await h.send(p, uid, 'hi')
    expect(t.done.message).toMatchObject({ body: 'second try', status: 'complete' })
    expect(chatRequests(h.mock)).toHaveLength(2)
  })

  it('finish_reason "error" after some text keeps the text and is not retried (no duplicate words)', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'half an ans', stopReason: 'error' })
    sendRaw(p, uid, 'f54e', 'hi')
    expect(await errorOf(p)).toMatchObject({ code: 'provider_error' })
    expect(chatRequests(h.mock)).toHaveLength(1)
    const s = repos().sessions.byUid(uid)!
    expect(repos().messages.tail(s.id, 1)[0]).toMatchObject({ status: 'error', body: 'half an ans' })
  })
})

describe('catalogue texts promise only what the engine does (F68)', () => {
  it('a 429 ends the turn without promising an automatic retry (the button counts down retryAfter)', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ error: { status: 429, retryAfterSec: 5 } })
    sendRaw(p, uid, 'f68a', 'hi')
    const err = await errorOf(p)
    expect(err).toMatchObject({ code: 'provider_rate', retryAfter: 5 })
    expect(err.message).not.toMatch(/retrying/i)
    expect(chatRequests(h.mock)).toHaveLength(1)
  })

  it('a context overflow that survives the forced rollover does not claim to be condensing; it says what to do', async () => {
    const { uid, p } = await fresh()
    await h.send(p, uid, 'first')
    const tooLong = { error: { status: 400, message: "This model's maximum context length is 8192 tokens." }, match: { lastUserIncludes: 'second' } }
    h.mock.llm.script(tooLong, tooLong)
    sendRaw(p, uid, 'f68b', 'second')
    const err = await errorOf(p)
    expect(err.code).toBe('provider_context')
    expect(err.message).not.toMatch(/condensing it|repairing it|retrying/i)
    expect(err.message).toMatch(/shorten|larger/i)
  })
})

describe('empty or cut-off answers are reported (F63)', () => {
  const html = '<!doctype html><html><head><title>Open WebUI</title></head><body>app</body></html>'

  it('a web page (HTML 200) at the address ends with "not the AI API" and Fix in Settings', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ raw: { contentType: 'text/html; charset=utf-8', body: html } })
    sendRaw(p, uid, 'f63a', 'hi')
    const err = await errorOf(p)
    expect(err.code).toBe('provider_bad_request')
    expect(err.message).toMatch(/web page/i)
    expect(JSON.stringify(err)).not.toContain('Open WebUI')
  })

  it('a server that ignores stream:true still gets its answer through', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'hi there', ignoreStream: true })
    const t = await h.send(p, uid, 'hello')
    expect(t.done.message).toMatchObject({ body: 'hi there', status: 'complete' })
  })

  it('an empty stream ([DONE] only) is an empty-reply error, not a blank "complete" bubble', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ emptyStream: true })
    sendRaw(p, uid, 'f63c', 'hi')
    const err = await errorOf(p)
    expect(err).toMatchObject({ code: 'provider_empty', retryable: true })
    const s = repos().sessions.byUid(uid)!
    const a = repos().messages.tail(s.id, 1)[0]
    expect(a).toMatchObject({ status: 'error', body: '' })
    // Nothing of the empty reply is replayed to the model (07 C6), and the chat goes on.
    expect(repos().transcript.forMessage(a.id)).toEqual([])
    expect((await h.send(p, uid, 'again')).done.message.body).toBe('Echo: again')
  })

  it('a model that spends its whole output limit thinking says so', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: '', reasoning: 'hmm '.repeat(50), stopReason: 'length' })
    sendRaw(p, uid, 'f63d', 'hi')
    const err = await errorOf(p)
    expect(err.code).toBe('provider_empty')
    expect(err.message).toMatch(/output limit/i)
  })

  it('a cut-off answer (finish_reason length) is kept, complete, and marked as cut off', async () => {
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: 'half an answer', stopReason: 'length' })
    const t = await h.send(p, uid, 'tell me everything')
    expect(t.done.message).toMatchObject({ body: 'half an answer', status: 'complete', truncated: true })
    const page = (await h.inject('GET', `/api/sessions/${uid}/messages?mode=latest`)).json() as { items: { truncated?: boolean }[] }
    expect(page.items.at(-1)!.truncated).toBe(true)
  })

  it('Anthropic: an empty message is reported too', async () => {
    await h.setProfile(h.anthropicProfile(), 'sk-ant-test-0123456789')
    const { uid, p } = await fresh()
    h.mock.llm.script({ text: '' })
    sendRaw(p, uid, 'f63f', 'hi')
    expect((await errorOf(p)).code).toBe('provider_empty')
  })
})
