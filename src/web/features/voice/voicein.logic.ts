/**
 * Voice-in helpers (R19, 07 C15/C17/B12): cloud STT choices, model download text, the echo self-test's chirp and
 * verdict. Pure, unit-tested.
 */
import type { SttModelInfo } from '@shared/models'

export type CloudSttId = 'openai' | 'groq' | 'deepgram' | 'elevenlabs'

/** Mirrors the server's CLOUD_PROVIDERS (src/server/providers/stt/cloud.ts): ids, default and offered models. */
export const STT_CLOUD: ReadonlyArray<{ id: CloudSttId; label: string; models: readonly string[]; defaultModel: string; disclosure: string; note: string }> = [
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-transcribe', 'whisper-1'], defaultModel: 'gpt-4o-mini-transcribe', disclosure: 'stt.openai', note: 'Accurate, many languages.' },
  { id: 'groq', label: 'Groq', models: ['whisper-large-v3-turbo', 'whisper-large-v3'], defaultModel: 'whisper-large-v3-turbo', disclosure: 'stt.groq', note: 'Very fast Whisper.' },
  { id: 'deepgram', label: 'Deepgram', models: ['nova-3', 'nova-2'], defaultModel: 'nova-3', disclosure: 'stt.deepgram', note: 'Fast; Vesper opts out of their model training.' },
  { id: 'elevenlabs', label: 'ElevenLabs', models: ['scribe_v2', 'scribe_v1'], defaultModel: 'scribe_v2', disclosure: 'stt.elevenlabs', note: 'Scribe, with the same key as their voices.' }
]

export function cloudStt(id: string): (typeof STT_CLOUD)[number] | undefined {
  return STT_CLOUD.find((p) => p.id === id)
}

/** `voice.stt.model` holds a catalogue id for local models and the provider's model name for cloud ones. */
export function effectiveCloudModel(id: string, model: string): string {
  const p = cloudStt(id)
  if (!p) return model
  return p.models.includes(model) ? model : p.defaultModel
}

export const STT_LANGUAGES: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' }
]

/** "212 MB of 487 MB", "Checking the download…", "Unpacking…". */
export function modelProgressText(m: Pick<SttModelInfo, 'state' | 'progress' | 'downloadBytes'>, fmt: (n: number) => string): string {
  if (m.state === 'verifying') return 'Checking the download…'
  if (m.state === 'extracting') return 'Unpacking…'
  const total = m.progress?.total || m.downloadBytes
  const bytes = m.progress?.bytes ?? 0
  return `${fmt(bytes)} of ${fmt(total)}`
}

export function modelProgressShare(m: Pick<SttModelInfo, 'state' | 'progress' | 'downloadBytes'>): number | undefined {
  if (m.state === 'verifying' || m.state === 'extracting') return undefined
  const total = m.progress?.total || m.downloadBytes
  if (!total) return undefined
  return Math.max(0, Math.min(1, (m.progress?.bytes ?? 0) / total))
}

export function isBusy(m: Pick<SttModelInfo, 'state'>): boolean {
  return m.state === 'downloading' || m.state === 'verifying' || m.state === 'extracting'
}

// ── echo self-test (07 C15, research 07 §3.2) ─────────────────────────────────────────────────

/** A 16-bit mono WAV of a log sine sweep (the "chirp" the echo test plays). */
export function chirpWav(ms = 2000, rate = 24000, from = 300, to = 3400, amplitude = 0.35): ArrayBuffer {
  const n = Math.round((ms / 1000) * rate)
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const w = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, n * 2, true)
  const T = ms / 1000
  const k = Math.log(to / from)
  const fade = Math.round(rate * 0.02)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    // Exponential sweep: phase = 2π f0 T / ln(f1/f0) · (e^{t·ln(f1/f0)/T} − 1)
    const phase = ((2 * Math.PI * from * T) / k) * (Math.exp((t * k) / T) - 1)
    const env = Math.min(1, i / fade, (n - 1 - i) / fade)
    v.setInt16(44 + i * 2, Math.round(Math.sin(phase) * amplitude * env * 32767), true)
  }
  return buf
}

export interface EchoVerdict {
  passed: boolean
  /** Mean mic level while the chirp played ÷ the room's noise floor. */
  ratio: number
  floor: number
  during: number
}

/** Median of a sample list (robust against a click or a cough). */
export function median(xs: readonly number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * The mic must barely hear the speaker for voice barge-in to be safe: what it picks up during the chirp (upper
 * quartile, so a loud speaker shows) may be at most 2.5× the room's floor and below an absolute level.
 */
export function echoVerdict(floorSamples: readonly number[], duringSamples: readonly number[]): EchoVerdict {
  const floor = Math.max(median(floorSamples), 0.002)
  const sorted = [...duringSamples].sort((a, b) => a - b)
  const during = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))] : 0
  const ratio = during / floor
  return { passed: duringSamples.length > 0 && ratio < 2.5 && during < 0.08, ratio, floor, during }
}
