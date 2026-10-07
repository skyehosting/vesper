/**
 * Tone adapters (R13, research 04 §7.4). The hidden `[tone=…]` value reaches a provider only through these: as an
 * audio-tag prefix (ElevenLabs v3/v4, stripped from the returned alignment), as `instructions` (OpenAI
 * gpt-4o-mini-tts), as a voice_settings preset (other ElevenLabs models) or as prosody (Windows). Providers without a
 * channel ignore it. The tone is never part of the spoken or shown text and is never persisted (07 A3).
 */

/** Clean a model-written tone into a short description: no brackets/newlines, ≤ 6 words, ≤ 60 chars. */
export function sanitizeTone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const words = raw
    .replace(/[[\]{}<>"`\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 6)
  let s = words.join(' ')
  if (s.length > 60) s = s.slice(0, 60).replace(/\s+\S*$/, '')
  return s || null
}

export interface TonePreset {
  /** ElevenLabs voice_settings for non-tag models. */
  stability: number
  style: number
  speed: number
  /** Windows prosody. */
  rate: number
  pitch: number
}

const NEUTRAL: TonePreset = { stability: 0.6, style: 0, speed: 1, rate: 1, pitch: 1 }

/** Tiny deterministic keyword classifier (no extra model call); unmatched tones are neutral. */
const CLASSES: Array<[RegExp, TonePreset]> = [
  [/\b(excit|happy|joy|cheer|playful|enthusias|thrill|delight|upbeat|energetic)/i, { stability: 0.3, style: 0.5, speed: 1.08, rate: 1.08, pitch: 1.05 }],
  [/\b(sad|tired|melanchol|somber|sombre|sorry|gloomy|weary|wistful)/i, { stability: 0.6, style: 0.2, speed: 0.9, rate: 0.9, pitch: 0.95 }],
  [/\b(serious|firm|stern|grave|formal|urgent)/i, { stability: 0.75, style: 0, speed: 0.97, rate: 0.97, pitch: 0.98 }],
  [/\b(warm|gentle|kind|soft|tender|caring|affection|teas|fond|friendly)/i, { stability: 0.5, style: 0.2, speed: 0.97, rate: 0.97, pitch: 1.02 }],
  [/\b(calm|neutral|relaxed|steady|soothing|quiet|whisper)/i, { stability: 0.6, style: 0, speed: 1, rate: 0.95, pitch: 1 }]
]

export function tonePreset(tone: string | null): TonePreset {
  if (!tone) return NEUTRAL
  for (const [re, p] of CLASSES) if (re.test(tone)) return p
  return NEUTRAL
}

/** ElevenLabs v3/v4 audio-tag prefix. */
export function toneTag(tone: string | null): string {
  const t = sanitizeTone(tone)
  return t ? `[${t}] ` : ''
}

/** OpenAI gpt-4o-mini-tts `instructions`. */
export function toneInstructions(tone: string | null): string | null {
  const t = sanitizeTone(tone)
  return t ? `Speak in a ${t} tone.` : null
}
