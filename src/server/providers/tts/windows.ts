/**
 * Windows voices (classic OneCore, offline and free — 07 A1/E7, research 04 §5) through the persistent WinRT host.
 * Timing comes from the host's word cues: characters inside a word are spread over the word's cue, characters between
 * words take the gap. Tone becomes prosody (rate/pitch); the user's speed multiplies the rate.
 */
import { VesperError } from '@shared/errors'
import type { Timeline } from '@shared/revealMap'
import type { Voice } from '@shared/types/domain'
import { readWav } from '../../speech/audio'
import { tonePreset } from '../../speech/tone'
import type { TtsProvider } from './types'
import type { WinTtsHost, WordCue } from './winttsHost'

/** Word cues → per-UTF-16-unit timeline over `text`, non-decreasing, ending within `durationMs`. */
export function cuesToTimeline(text: string, words: readonly WordCue[], durationMs: number): Timeline {
  const n = text.length
  const starts = new Array<number>(n).fill(NaN)
  const ends = new Array<number>(n).fill(NaN)
  for (const w of [...words].sort((a, b) => a.startMs - b.startMs)) {
    const from = Math.max(0, Math.min(n - 1, w.pos))
    const to = Math.max(from, Math.min(n - 1, w.end))
    const len = to - from + 1
    for (let k = from; k <= to; k++) {
      if (!Number.isNaN(starts[k])) continue
      starts[k] = w.startMs + (w.durMs * (k - from)) / len
      ends[k] = w.startMs + (w.durMs * (k - from + 1)) / len
    }
  }
  let prevEnd = 0
  for (let k = 0; k < n; k++) {
    if (Number.isNaN(starts[k])) {
      let next = k + 1
      while (next < n && Number.isNaN(starts[next])) next++
      const nextStart = next < n ? starts[next] : durationMs
      starts[k] = prevEnd
      ends[k] = Math.max(prevEnd, nextStart)
    }
    starts[k] = Math.min(durationMs, Math.max(starts[k], k ? starts[k - 1] : 0))
    ends[k] = Math.min(durationMs, Math.max(ends[k], starts[k]))
    prevEnd = ends[k]
  }
  const r = (x: number) => Math.round(x * 10) / 10
  return { startsMs: starts.map(r), endsMs: ends.map(r) }
}

export function createWindowsTts(getHost: () => WinTtsHost, platform: NodeJS.Platform = process.platform): TtsProvider {
  const provider: TtsProvider = {
    id: 'windows',
    available: () => platform === 'win32',

    async synthesize(req, signal) {
      if (platform !== 'win32') throw new VesperError('tts_failed', { message: 'Windows voices are only available on Windows.' })
      const p = tonePreset(req.tone)
      const rate = Math.min(3, Math.max(0.5, req.speed * p.rate))
      const { wav, words } = await getHost().speak({ text: req.text, voice: req.voiceId, rate, pitch: p.pitch, volume: 1 }, signal)
      const info = readWav(wav)
      if (!info) throw new VesperError('tts_failed')
      return { audio: wav, mime: 'audio/wav', durationMs: info.durationMs, timeline: cuesToTimeline(req.text, words, info.durationMs), timing: 'cues' }
    },

    async list(signal) {
      if (platform !== 'win32') return { voices: [], models: [] }
      const voices: Voice[] = (await getHost().voices(signal)).map((v) => ({ id: v.name, name: v.name, provider: 'windows', language: v.language || undefined, gender: v.gender ? v.gender.toLowerCase() : undefined, previewable: true }))
      return { voices, models: [] }
    },

    defaultVoice(list) {
      return list.voices[0]?.id ?? null
    },

    defaultModel() {
      return null
    }
  }
  return provider
}
