/**
 * Genuine offline transcription with the real models from the research phase @R19 — runs only when
 * VESPER_STT_MODEL_DIR points at the extracted sherpa models (research 05: Vesper/.scratch/stt/models) and their
 * fixtures sit in `<dir>/../audio` (or VESPER_STT_AUDIO_DIR). Nothing is downloaded. The full path is exercised: the
 * bundled STT process, Silero VAD endpointing with pre-roll, and the recognizer's final re-decode.
 *
 *   VESPER_STT_MODEL_DIR=<folder with the sherpa-onnx models> npm test -- tests/unit/stt/real-models
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { STT_MODELS } from '../../../src/shared/models'
import { decodeWav } from '../../../src/server/providers/stt/pcm'
import type { FromProcess, LoadSpec, MicOptions } from '../../../src/server/providers/stt/protocol'
import { SttProcess } from '../../../src/server/providers/stt/processClient'
import { fakeLog } from '../../fakes'
import { buildSttWorker, concat, frames, realModels, silence, VAD_MODEL, waitFor, wer, workerForker, type ForkedWorkers } from './helpers'

const real = realModels()
const CLIPS = ['a', 'b', 'c', 'd', 'e', 'f', 'dn']

const MIC: MicOptions = { mode: 'dictate', silenceMs: 1000, lang: 'auto', ttsActive: false, bargeIn: 'tap', vadThreshold: 0.5, preRollMs: 400, maxUtteranceMs: 60_000, wantAudio: false, partials: false }

describe.skipIf(!real)('real models (VESPER_STT_MODEL_DIR) @R19', () => {
  let forker: ForkedWorkers
  beforeAll(async () => {
    forker = workerForker(await buildSttWorker())
  })
  afterAll(() => forker.killAll())

  async function transcribeAll(id: string): Promise<{ wer: number; texts: Record<string, string>; loadMs: number }> {
    const entry = STT_MODELS.find((m) => m.id === id)!
    const proc = new SttProcess({ fork: () => forker.fork(), log: fakeLog(), now: () => Date.now() })
    const out: FromProcess[] = []
    proc.onEvent((e) => {
      if (e.t !== 'exit') out.push(e)
    })
    const spec: LoadSpec = { key: id, model: { id, family: entry.family, dir: path.join(real!.dir, entry.dir) }, vadModel: VAD_MODEL, threads: 4, lang: 'auto', fake: false }
    const t0 = Date.now()
    await proc.load(spec)
    const loadMs = Date.now() - t0
    const texts: Record<string, string> = {}
    let errors = 0
    let words = 0
    for (const clip of CLIPS) {
      const { pcm } = decodeWav(fs.readFileSync(path.join(real!.audio, `${clip}.wav`)))
      const ref = fs.readFileSync(path.join(real!.audio, `${clip}.txt`), 'utf8').trim()
      proc.post({ t: 'open', micId: clip, o: MIC })
      for (const f of frames(concat(silence(500), pcm, silence(1600)))) proc.post({ t: 'frames', micId: clip, pcm: f })
      const final = (await waitFor(() => out.find((m) => m.t === 'final' && m.micId === clip), 30_000)) as Extract<FromProcess, { t: 'final' }>
      proc.post({ t: 'close', micId: clip, reason: 'cancel' })
      texts[clip] = final.text
      const n = ref.split(/\s+/).length
      errors += wer(ref, final.text) * n
      words += n
    }
    await proc.close()
    if (process.env.VESPER_STT_REPORT) fs.appendFileSync(process.env.VESPER_STT_REPORT, `${JSON.stringify({ id, wer: errors / words, loadMs, texts })}\n`)
    return { wer: errors / words, texts, loadMs }
  }

  it('Moonshine base (light option): near-perfect on the fixtures', async () => {
    const r = await transcribeAll('moonshine-base-en-2026-02-27')
    expect(r.texts.c).toMatch(/quick brown fox/i)
    // b has a 0.83 s pause between its sentences: one utterance, not two (onset guard)
    expect(r.texts.b).toMatch(/garden/)
    expect(r.wer).toBeLessThanOrEqual(0.02)
  }, 120_000)

  it('Parakeet TDT 0.6B v3 (default): near-perfect on the fixtures, with punctuation', async () => {
    const r = await transcribeAll('parakeet-tdt-0.6b-v3-int8')
    expect(r.texts.b).toMatch(/Tuesday\? I think .*garden\./)
    expect(r.wer).toBeLessThanOrEqual(0.03)
  }, 180_000)
})
