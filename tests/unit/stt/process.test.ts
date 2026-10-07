/**
 * The STT process protocol over a real child process (07 C17, C19) @R19: hello → load → loaded | loadError,
 * frames → final, unload = exit, a model switch replaces the process, crash restarts are rate-limited.
 */
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FromProcess, LoadSpec } from '../../../src/server/providers/stt/protocol'
import { SttProcess } from '../../../src/server/providers/stt/processClient'
import { fakeLog, tempDir } from '../../fakes'
import { buildSttWorker, concat, fixture, frames, silence, VAD_MODEL, waitFor, workerForker, type ForkedWorkers } from './helpers'

let forker: ForkedWorkers
beforeAll(async () => {
  forker = workerForker(await buildSttWorker())
})
afterAll(() => forker.killAll())

const fake = (key = 'fake'): LoadSpec => ({ key, model: { id: 'm', family: 'moonshine', dir: '' }, vadModel: VAD_MODEL, threads: 1, lang: 'auto', fake: true, fakeTexts: ['one', 'two'] })

function client(o: { backoffMs?: number[] } = {}) {
  const p = new SttProcess({ fork: () => forker.fork(), log: fakeLog(), now: () => Date.now(), backoffMs: o.backoffMs ?? [10, 10, 10] })
  const events: (FromProcess | { t: 'exit'; code: number; expected: boolean })[] = []
  p.onEvent((e) => events.push(e))
  return { p, events }
}

describe('STT process protocol @R19', () => {
  it('load → open → frames → final → close → closed; unload ends the process', async () => {
    const { p, events } = client()
    await p.load(fake())
    expect(p.loaded).toBe('fake')
    p.post({ t: 'open', micId: 'a', o: { mode: 'dictate', silenceMs: 700, lang: 'auto', ttsActive: false, bargeIn: 'tap', vadThreshold: 0.5, preRollMs: 400, maxUtteranceMs: 30_000, wantAudio: false, partials: true } })
    for (const f of frames(concat(silence(300), fixture('hello').pcm, silence(1000)))) p.post({ t: 'frames', micId: 'a', pcm: f })
    await waitFor(() => events.find((e) => e.t === 'final'))
    p.post({ t: 'close', micId: 'a', reason: 'cancel' })
    await waitFor(() => events.find((e) => e.t === 'closed'))
    expect(events.find((e) => e.t === 'final')).toMatchObject({ micId: 'a', text: 'one' })
    const stats = await p.stats()
    expect(stats).toMatchObject({ sessions: 0, bufferedSamples: 0, loaded: 'fake' })
    expect(stats!.rssMB).toBeGreaterThan(0)
    const pid = p.pid as number
    await p.stop()
    expect(p.alive).toBe(false)
    expect(events.at(-1)).toMatchObject({ t: 'exit', expected: true })
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('a missing model directory is stt_model_missing and the process goes away', async () => {
    const { p } = client()
    const spec: LoadSpec = { ...fake('real'), fake: false, model: { id: 'x', family: 'nemo-transducer', dir: path.join(tempDir(), 'nothing') } }
    await expect(p.load(spec)).rejects.toMatchObject({ info: { code: 'stt_model_missing' } })
    await waitFor(() => !p.alive)
  })

  it('a different model replaces the process (the old model is freed)', async () => {
    const { p } = client()
    await p.load(fake('a'))
    const first = p.pid as number
    await p.load(fake('a'))
    expect(p.spawned).toBe(1)
    await p.load(fake('b'))
    expect(p.spawned).toBe(2)
    expect(p.pid).not.toBe(first)
    expect(() => process.kill(first, 0)).toThrow()
    await p.close()
  })

  it('restarts after crashes with backoff, then gives up after 3 in 5 minutes (07 C19)', async () => {
    const { p, events } = client({ backoffMs: [20, 40, 80] })
    for (let i = 0; i < 4; i++) {
      await p.load(fake())
      process.kill(p.pid as number)
      await waitFor(() => events.filter((e) => e.t === 'exit').length === i + 1)
    }
    expect(events.filter((e) => e.t === 'exit').every((e) => e.t === 'exit' && !e.expected)).toBe(true)
    await expect(p.load(fake())).rejects.toMatchObject({ info: { code: 'stt_unavailable' } })
    expect(p.spawned).toBe(4)
  })
})
