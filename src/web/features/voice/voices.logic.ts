/**
 * Voice-out helpers (R12, 07 C22): provider metadata, voice/model options and quota text. Pure, unit-tested.
 */
import type { ModelInfo, Voice } from '@shared/types/domain'
import type { TtsProviderId } from '@shared/settings'

export type UiTtsProvider = Exclude<TtsProviderId, 'piper'>

export interface ProviderMeta {
  id: UiTtsProvider
  label: string
  description: string
  /** Secret name in secrets.json (null = no key). */
  secret: string | null
  /** src/shared/privacy.ts disclosure id. */
  disclosure: string
  /** The text leaves this PC. */
  cloud: boolean
  /** A base URL is needed. */
  needsUrl: boolean
  keyPlaceholder?: string
}

/** 07 C22 order: ElevenLabs · OpenAI · Windows voices · OpenAI-compatible. */
export const TTS_PROVIDER_META: readonly ProviderMeta[] = [
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    description: 'The most natural voices, with tone (audio tags). Your own key; usage is billed per character.',
    secret: 'tts:elevenlabs',
    disclosure: 'elevenlabs',
    cloud: true,
    needsUrl: false,
    keyPlaceholder: 'Paste your ElevenLabs API key'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Clear, fast voices. gpt-4o-mini-tts follows the tone.',
    secret: 'tts:openai',
    disclosure: 'openai-tts',
    cloud: true,
    needsUrl: false,
    keyPlaceholder: 'sk-…'
  },
  {
    id: 'windows',
    label: 'Windows voices',
    description: 'Built into Windows. Free, offline, classic-sounding.',
    secret: null,
    disclosure: 'windows-voices',
    cloud: false,
    needsUrl: false
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    description: 'Any server with the OpenAI speech API — for example a local one.',
    secret: 'tts:openai-compatible',
    // Never OpenAI's terms: the text depends on the server address (ttsDisclosure, F20).
    disclosure: 'tts-custom',
    cloud: true,
    needsUrl: true,
    keyPlaceholder: 'Key (if your server needs one)'
  }
]

export function providerMeta(id: string): ProviderMeta {
  return TTS_PROVIDER_META.find((p) => p.id === id) ?? TTS_PROVIDER_META[2]
}

/** "/voice aria" → the voice whose name (or id) matches best: exact, then prefix, then substring. */
export function matchVoice(voices: readonly Voice[], query: string): Voice | null {
  const q = query.trim().toLowerCase()
  if (!q) return null
  const name = (v: Voice): string => v.name.toLowerCase()
  return (
    voices.find((v) => name(v) === q || v.id.toLowerCase() === q) ??
    voices.find((v) => name(v).startsWith(q)) ??
    voices.find((v) => name(v).replace(/^microsoft\s+/, '').startsWith(q)) ??
    voices.find((v) => name(v).includes(q)) ??
    null
  )
}

/** One line under a voice in the dropdown: "premade · American · female". */
export function voiceDetail(v: Voice): string {
  return [v.category, v.language, v.gender].filter((x): x is string => !!x && x.trim().length > 0).join(' · ')
}

/** Voices sorted for the dropdown: premade first (07 C22 auto-selects the first premade), then by name. */
export function sortVoices(voices: readonly Voice[]): Voice[] {
  const rank = (v: Voice): number => (v.category === 'premade' ? 0 : v.category === 'cloned' || v.category === 'generated' ? 2 : 1)
  return [...voices].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/** Badges for a TTS model: relative price and speed (07 C22: show per-model price). */
export function modelBadges(m: ModelInfo, cheapest: number): Array<{ text: string; tone: 'success' | 'info' | 'neutral' | 'warning' }> {
  const out: Array<{ text: string; tone: 'success' | 'info' | 'neutral' | 'warning' }> = []
  if (typeof m.costMultiplier === 'number') {
    if (m.costMultiplier <= cheapest) out.push({ text: m.costMultiplier < 1 ? `${formatMultiplier(m.costMultiplier)} price` : 'Lowest price', tone: 'success' })
    else out.push({ text: `${formatMultiplier(m.costMultiplier)} price`, tone: m.costMultiplier > 1 ? 'warning' : 'neutral' })
  }
  if (m.fast) out.push({ text: 'Fast', tone: 'info' })
  if (m.audioTags) out.push({ text: 'Tone tags', tone: 'neutral' })
  return out
}

export function formatMultiplier(x: number): string {
  if (x === 0.5) return '½×'
  return `${Number.isInteger(x) ? x : x.toFixed(2).replace(/0$/, '')}×`
}

/** "12,400 of 30,000 characters left this month". */
export function quotaText(q: { used: number; limit: number } | undefined | null): string | null {
  if (!q || !(q.limit > 0)) return null
  const left = Math.max(0, q.limit - q.used)
  return `${left.toLocaleString('en-US')} of ${q.limit.toLocaleString('en-US')} characters left`
}

export function quotaShare(q: { used: number; limit: number } | undefined | null): number | null {
  if (!q || !(q.limit > 0)) return null
  return Math.max(0, Math.min(1, (q.limit - q.used) / q.limit))
}

/** A key that obviously doesn't belong to the provider (quick client check before the server's validation). */
export function keyLooksWrong(provider: UiTtsProvider | 'stt', value: string): string | null {
  const v = value.trim()
  if (v.length < 8) return 'That key looks too short.'
  if (/\s/.test(v)) return 'Keys have no spaces.'
  if (provider === 'openai' && !v.startsWith('sk-')) return 'OpenAI keys start with "sk-".'
  return null
}
