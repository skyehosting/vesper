import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpeechChunkHeader } from '../../../src/shared/ws/index'
import { FakeChatService, FakeMemoryService, FakeSpeechService, FakeSttService, FakeWsClient, fakeLog, fakePlatform, removeTempDir, tempDir } from '../../fakes'

describe('test fakes', () => {
  it('FakeSpeechService records push/tone/end/abort and resolves done', async () => {
    const speech = new FakeSpeechService()
    const sink = speech.open({ replyId: 'r1', sessionUid: 's1', clientIds: ['c1'] }, { talkMode: false })
    sink.tone('warm', 0)
    sink.push('Hello ')
    sink.push('there.')
    sink.end('Hello there.')
    sink.push('late')
    expect(sink.calls.map((c) => c.op)).toEqual(['tone', 'push', 'push', 'end'])
    expect(sink.text).toBe('Hello there.')
    expect(sink.tones).toEqual([{ value: 'warm', at: 0 }])
    expect(sink.lateCalls).toEqual([{ op: 'push', text: 'late' }])
    await expect(sink.done).resolves.toEqual({ chunks: 2, spokenChars: 12, interrupted: false, failed: false })

    const s2 = speech.open({ replyId: 'r2', sessionUid: 's1', clientIds: ['c1'] }, { talkMode: true })
    s2.push('Interrupted mid')
    speech.cancel('r2', 5)
    await expect(s2.done).resolves.toMatchObject({ interrupted: true })
    expect(speech.cancelled).toEqual([{ replyId: 'r2', spokenChars: 5 }])
    expect(speech.lastSink()).toBe(s2)
  })

  it('FakeMemoryService searches its corpus and records calls', async () => {
    const mem = new FakeMemoryService()
    mem.addHit({ body: 'We talked about the Lisbon trip', shortId: 'AAAAAA' })
    mem.addHit({ body: 'Bread recipe', shortId: 'BBBBBB' })
    const r = await mem.search({ query: 'lisbon' }, { sessionUid: 's' }, 1000)
    expect(r.hits.map((h) => h.shortId)).toEqual(['AAAAAA'])
    expect((await mem.recall({ shortId: '#BBBBBB' }, { sessionUid: 's' })).hits).toHaveLength(1)
    mem.onMessagePersisted(5n)
    expect(mem.persisted).toEqual([5n])
    expect(mem.callsOf('search')).toHaveLength(1)
    expect(mem.formatResult(r.hits, { query: 'lisbon', nowUtc: Date.UTC(2026, 9, 5), tzName: 'UTC', tzOffsetMin: 0 })).toMatch(/^<memory_result id="r_fake">/)
  })

  it('FakeSttService and FakeChatService keep simple state', async () => {
    const stt = new FakeSttService()
    await stt.download('moonshine-base-en-2026-02-27')
    expect((await stt.models()).find((m) => m.id === 'moonshine-base-en-2026-02-27')?.state).toBe('installed')
    const chat = new FakeChatService()
    chat.busySessions.add('s')
    expect(chat.busy('s')).toBe(true)
    chat.stop('s')
    expect(chat.busy('s')).toBe(false)
    expect(await chat.newEpoch('s', 'overflow')).toBe(1)
  })

  it('FakeWsClient records messages and applies backpressure', () => {
    const c = new FakeWsClient('c1', { kind: 'browser' })
    c.send({ t: 'toast', tone: 'info', text: 'hi' })
    expect(c.of('toast')).toHaveLength(1)
    expect(c.isDesktop).toBe(false)
    c.bufferedAmount = 2 * 1024 * 1024
    expect(c.sendSpeech({} as SpeechChunkHeader, new Uint8Array(1))).toBe(false)
  })

  it('fakePlatform keeps secrets in memory and has a controllable clock; tempDir cleans up', async () => {
    const dir = tempDir()
    const p = fakePlatform(dir, { now: 1000 })
    await p.secrets.set('voyage', 'pa-x')
    expect(await p.secrets.list()).toEqual(['voyage'])
    expect(await p.secrets.get('voyage')).toBe('pa-x')
    expect(p.now()).toBe(1000)
    p.advance(500)
    expect(p.now()).toBe(1500)
    p.notify('t', 'b')
    expect(p.notifications).toEqual([{ title: 't', body: 'b' }])
    await expect(fakePlatform(dir, { secretsUnavailable: true }).secrets.set('x', 'y')).rejects.toThrow()
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x')
    removeTempDir(dir)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('fakePlatform forks a worker that talks over IPC', async () => {
    const dir = tempDir()
    const script = path.join(dir, 'worker.cjs')
    fs.writeFileSync(script, "process.on('message', (m) => { process.send({ echo: m }); process.exit(0) })")
    const w = fakePlatform(dir).forkWorker(script, [], { name: 'echo' })
    const reply = await new Promise<unknown>((resolve) => {
      w.on('message', resolve)
      w.postMessage({ ping: 1 })
    })
    expect(reply).toEqual({ echo: { ping: 1 } })
    removeTempDir(dir)
  })

  it('fakeLog keeps every line', () => {
    const log = fakeLog()
    log.child('db').warn('slow', { ms: 12 })
    expect(log.text()).toBe('warn test.db slow {"ms":12}')
  })
})
