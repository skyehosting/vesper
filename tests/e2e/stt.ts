/**
 * E2E helper for voice input (owner: voice-in-server): streams a WAV fixture as 16 kHz Int16 mic frames (binary
 * kind 2, 512 samples = 32 ms, paced like the client's AudioWorklet) over a WebSocket opened inside the page — the
 * page's own cookie and origin — and collects the stt.* events until `stt.final`. Proves the server half of R19
 * end to end without the voice-client UI.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { parseWav } from '../mocks/audio'

export const AUDIO_FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'audio')

/** Where the fixture's speech ends (last sample above -36 dBFS), in ms from its start. */
export function speechEndMs(name: string): number {
  const w = parseWav(fs.readFileSync(path.join(AUDIO_FIXTURES, `${name}.wav`)))
  for (let i = w.pcm.length - 1; i >= 0; i--) if (Math.abs(w.pcm[i]) > 500) return Math.round(i / 16)
  return 0
}

/** A fixture as base64 Int16 LE PCM (16 kHz mono), padded with silence. */
export function fixturePcm(name: string, padMs = { before: 300, after: 1600 }): string {
  const w = parseWav(fs.readFileSync(path.join(AUDIO_FIXTURES, `${name}.wav`)))
  if (w.sampleRate !== 16000 || w.channels !== 1) throw new Error(`${name}.wav must be 16 kHz mono`)
  const pre = Math.round(padMs.before * 16)
  const post = Math.round(padMs.after * 16)
  const all = new Int16Array(pre + w.pcm.length + post)
  all.set(w.pcm, pre)
  return Buffer.from(all.buffer).toString('base64')
}

export interface DictationResult {
  final: { text: string; autoSend: boolean; durationMs: number }
  events: string[]
  states: string[]
  /** Audio already sent (ms of PCM) when stt.final arrived: speech end + silence wait + latency. */
  audioMsAtFinal: number
}

export async function wsDictation(page: Page, pcmBase64: string, o: { mode?: 'dictate' | 'ptt' | 'conversation'; frameMs?: number; timeoutMs?: number } = {}): Promise<DictationResult> {
  return page.evaluate(
    ({ pcm64, mode, frameMs, limit }) =>
      new Promise<DictationResult>((resolve, reject) => {
        const bin = atob(pcm64)
        const bytes = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
        ws.binaryType = 'arraybuffer'
        const events: string[] = []
        const states: string[] = []
        let sentBytes = 0
        let settled = false
        let pump: ReturnType<typeof setInterval> | null = null
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (pump) clearInterval(pump)
          ws.close()
          fn()
        }
        const timer = setTimeout(() => finish(() => reject(new Error(`wsDictation timed out; events: ${events.join(', ')}`))), limit)
        const send = (m: Record<string, unknown>): void => ws.send(JSON.stringify(m))
        const enc = new TextEncoder()
        const frame = (seq: number, payload: Uint8Array): Uint8Array => {
          const h = enc.encode(JSON.stringify({ seq }))
          const out = new Uint8Array(5 + h.length + payload.length)
          out[0] = 2
          new DataView(out.buffer).setUint32(1, h.length, false)
          out.set(h, 5)
          out.set(payload, 5 + h.length)
          return out
        }
        const stream = (): void => {
          let off = 0
          let seq = 0
          pump = setInterval(() => {
            if (off >= bytes.length) {
              if (pump) clearInterval(pump)
              pump = null
              return
            }
            ws.send(frame(seq++, bytes.subarray(off, Math.min(bytes.length, off + 1024))))
            off += 1024
            sentBytes = Math.min(bytes.length, off)
          }, frameMs)
        }
        ws.onopen = () => send({ t: 'hello', protocol: 1, tz: 'UTC', tzOffset: 0, client: { visible: true, focused: false, audioUnlocked: false }, deviceName: 'e2e-mic' })
        ws.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data !== 'string') return
          const m = JSON.parse(ev.data) as { t: string; [k: string]: unknown }
          events.push(m.t)
          if (m.t === 'ping') send({ t: 'pong', ts: m.ts })
          else if (m.t === 'ready') send({ t: 'stt.start', id: 'e2e-stt', sessionUid: null, mode, sampleRate: 16000, ttsActive: false })
          else if (m.t === 'ack' && m.id === 'e2e-stt') stream()
          else if (m.t === 'stt.state') {
            states.push(String(m.state))
            if (m.state === 'error') finish(() => reject(new Error(`stt error: ${JSON.stringify(m.error)}`)))
          } else if (m.t === 'stt.final') {
            const final = { text: String(m.text), autoSend: !!m.autoSend, durationMs: Number(m.durationMs) }
            finish(() => resolve({ final, events, states, audioMsAtFinal: Math.round(sentBytes / 32) }))
          } else if (m.t === 'error' && m.id === 'e2e-stt') finish(() => reject(new Error(`stt.start failed: ${JSON.stringify(m)}`)))
        }
        ws.onerror = () => finish(() => reject(new Error(`WebSocket error; events: ${events.join(', ')}`)))
        ws.onclose = (ev: CloseEvent) => finish(() => reject(new Error(`WebSocket closed (${ev.code} ${ev.reason}); events: ${events.join(', ')}`)))
      }),
    { pcm64: pcmBase64, mode: o.mode ?? 'conversation', frameMs: o.frameMs ?? 32, limit: o.timeoutMs ?? 30_000 }
  )
}
