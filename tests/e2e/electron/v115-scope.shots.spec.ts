/**
 * Vesper 1.1.5 avatar capture on the REAL GPU (opt-in: V115_SHOTS=1). The desktop window sits on the secondary display
 * (the launcher's dev-window placement, click-through, never focused).
 *   - scope-dark.png: a conversation while the AI speaks real speech — the horizon's front is a live, stationary
 *     oscilloscope of that audio (curves up and down, nothing travelling sideways);
 *   - log.txt: the latency numbers on this machine (AudioContext.outputLatency / baseLatency, the output-timestamp
 *     delay the engine reports, the delay the oscilloscope applies and the drawn audio's age).
 * Images land in V115_OUT (default: the main checkout's git-ignored .scratch/v115/).
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, wsTurn } from '../helpers'
import { launchApp, type TestApp } from '../launch'
import { AUDIO_FIXTURES } from '../stt'

const OUT = process.env.V115_OUT ?? 'C:\\Users\\Raven\\Desktop\\Vesper\\.scratch\\v115'

test.skip(!process.env.V115_SHOTS, 'v1.1.5 oscilloscope capture: set V115_SHOTS=1')
test.describe.configure({ timeout: 300_000 })

let mock: MockServer
let t: TestApp | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
  fs.mkdirSync(OUT, { recursive: true })
})
test.afterEach(async () => {
  await t?.close()
  t = null
})
test.afterAll(async () => {
  await mock?.close()
})

/** Real speech for the AI's voice: the fixtures' words several times over, as one 16-bit mono WAV. */
function speech(): { b64: string; ms: number } {
  const parts = ['hello.wav', 'search.wav', 'hello.wav', 'search.wav', 'hello.wav', 'search.wav'].map((f) => {
    const b = fs.readFileSync(path.join(AUDIO_FIXTURES, f))
    let off = 12
    let rate = 16000
    while (off < b.length - 8) {
      const id = b.toString('ascii', off, off + 4)
      const size = b.readUInt32LE(off + 4)
      if (id === 'fmt ') rate = b.readUInt32LE(off + 12)
      if (id === 'data') return { rate, pcm: b.subarray(off + 8, off + 8 + size) }
      off += 8 + size + (size % 2)
    }
    throw new Error(`no data in ${f}`)
  })
  const rate = parts[0].rate
  const pcm = Buffer.concat(parts.map((p) => p.pcm))
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(pcm.length, 40)
  return { b64: Buffer.concat([h, pcm]).toString('base64'), ms: (pcm.length / 2 / rate) * 1000 }
}

interface Wave {
  heights: number[]
  level: number
  delayMs: number
  ageMs: number
  windowMs: number
}

test('v1.1.5 avatar: the live oscilloscope while the AI speaks (dark)', async () => {
  t = await launchApp({ mock, size: '1440x900' })
  await t.waitHook('presence.surface')
  await configureMockLlm(t.api, mock.url)
  expect((await t.api('PATCH', '/api/settings', { performance: { gameMode: 'off' }, appearance: { theme: 'dark', accent: 'gold' } })).status).toBe(200)
  await t.hook('presence.setFocus', true)
  await t.hook('audio.unlock')
  const chat = (await t.api<{ uid: string }>('POST', '/api/sessions', { title: 'Evening walk' })).json
  await t.hook('go', `/s/${chat.uid}`)
  await t.waitReady()
  mock.llm.script({ text: 'It was a good walk. You went along the river path as far as the old mill, about four kilometres, and turned back when the light started going.' })
  await wsTurn(t.page, chat.uid, 'Can you remind me how far I walked on Sunday?')
  await t.page.waitForSelector('article.msg')
  await t.page.waitForTimeout(1200)

  const wav = speech()
  await t.hook('presence.speakWav', wav.b64, wav.ms)
  const swing = async (): Promise<number> => {
    const w = await t!.hook<Wave | null>('presence.armillaWave', 96)
    return w ? Math.max(0, ...w.heights.map(Math.abs)) : 0
  }
  // A loud moment with clear curves across the front.
  await expect.poll(swing, { timeout: 15_000, intervals: [30] }).toBeGreaterThan(0.55)
  await t.page.screenshot({ path: path.join(OUT, 'scope-dark.png') })
  const w = await t.hook<Wave>('presence.armillaWave', 96)
  const clock = await t.hook<{ base: number; output: number }>('audio.clock')
  const probe = await t.hook<{ last: Record<string, number> | null }>('presence.armilla')
  const log = [
    `AudioContext.outputLatency ${clock.output.toFixed(1)} ms, baseLatency ${clock.base.toFixed(1)} ms`,
    `engine output delay (currentTime − output timestamp) ${Number(probe.last?.latencyMs ?? 0).toFixed(1)} ms`,
    `scope: window ${w.windowMs} ms, delay applied ${w.delayMs.toFixed(1)} ms, drawn audio age ${w.ageMs.toFixed(1)} ms, level ${w.level.toFixed(2)}`
  ]
  fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n') + '\n')
  console.log(log.join('\n'))
  await t.hook('audio.stop')
  await t.assertNoErrors()
})
