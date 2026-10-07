/**
 * Voice tone modes (R13, 07 A2, H-v11-tone). `voice.tts.toneMode` says how the AI tags the tone of its voice:
 *
 *   - 'off'          — no tone instruction; stray `[tone=…]` tags are still stripped (never shown, spoken or stored)
 *                      and no tone reaches a provider;
 *   - 'conversation' — the default: the first spoken reply sets a tone, later replies write a tag only when the
 *                      emotional tone of the conversation shifts, and the current tone carries on in between;
 *   - 'reply'        — every spoken reply carries its own tag (Vesper ≤ 1.0.0).
 *
 * Only voices that can use a tone get one: every ElevenLabs model (audio tags on v3/v4, voice settings on the others),
 * OpenAI's gpt-4o models (`instructions`), OpenAI-compatible servers running a gpt-4o model, and the Windows voices
 * (a little faster/slower and higher/lower). With any other voice the effective mode is 'off', so the AI is not asked
 * to write tags it can't use. Shared by the server (protocols, notes, speech) and the Settings UI.
 */
import type { TtsProviderId } from './settings'

export const TONE_MODES = ['off', 'conversation', 'reply'] as const
export type ToneMode = (typeof TONE_MODES)[number]
export type TonePlacement = 'start' | 'end'

export function isToneMode(v: unknown): v is ToneMode {
  return typeof v === 'string' && (TONE_MODES as readonly string[]).includes(v)
}

/** Settings files written before toneMode (Vesper ≤ 1.0.0) have `tone: boolean`: false → 'off', true → the default. */
export function toneModeOfLegacy(tone: unknown): ToneMode | undefined {
  if (tone === false) return 'off'
  if (tone === true) return 'conversation'
  return undefined
}

/**
 * Rewrite a raw `voice.tts` object that still carries the old `tone` boolean (a settings file, or a PATCH from an older
 * client) into `toneMode`. An explicit `toneMode` wins. Returns a new object; anything else passes through.
 */
export function migrateToneSettings(tts: unknown): unknown {
  if (typeof tts !== 'object' || tts === null || Array.isArray(tts) || !('tone' in tts)) return tts
  const { tone, ...rest } = tts as Record<string, unknown>
  if (rest.toneMode !== undefined) return rest
  const mode = toneModeOfLegacy(tone)
  return mode ? { ...rest, toneMode: mode } : rest
}

export interface ToneSupport {
  ok: boolean
  /** One plain sentence: how this voice uses a tone, or why it can't. */
  text: string
}

const OPENAI_TONE_MODEL = /^gpt-4o/

/** Can this provider/model use a tone? `model` null = the provider's default model. */
export function toneSupport(provider: TtsProviderId | string, model: string | null | undefined): ToneSupport {
  switch (provider) {
    case 'elevenlabs':
      return { ok: true, text: 'ElevenLabs follows the tone (audio tags on v3/v4 models, voice settings on the others).' }
    case 'openai':
      // No model chosen: OpenAI's default is gpt-4o-mini-tts (providers/tts/openai.ts).
      return OPENAI_TONE_MODEL.test(model || 'gpt-4o-mini-tts')
        ? { ok: true, text: 'gpt-4o-mini-tts follows the tone as a speaking instruction.' }
        : { ok: false, text: 'This OpenAI model can’t change its tone — choose gpt-4o-mini-tts to use tones.' }
    case 'openai-compatible':
      return model && OPENAI_TONE_MODEL.test(model)
        ? { ok: true, text: 'This server’s gpt-4o model follows the tone as a speaking instruction.' }
        : { ok: false, text: 'This voice server can’t change its tone, so the AI isn’t asked to write tone tags.' }
    case 'windows':
      return { ok: true, text: 'Windows voices follow the tone lightly: a little faster or slower, higher or lower.' }
    default:
      return { ok: false, text: 'This voice can’t change its tone, so the AI isn’t asked to write tone tags.' }
  }
}

export interface ToneTtsSettings {
  enabled: boolean
  provider: TtsProviderId | string
  model: string | null
  toneMode: ToneMode
}

/** A chat's own voice (`sessions.voice`, R12), which may name another provider and model. */
export interface ToneVoiceOverride {
  provider: string
  voiceId?: string
  model?: string
}

/** The provider and model replies are spoken with: the chat's own voice when it has one, else Settings. */
export function voiceInUse(tts: Pick<ToneTtsSettings, 'provider' | 'model'>, override?: ToneVoiceOverride | null): { provider: string; model: string | null } {
  if (override && override.provider) {
    const own = override.provider === tts.provider
    return { provider: override.provider, model: override.model || (own ? tts.model : null) }
  }
  return { provider: tts.provider, model: tts.model }
}

/** The mode a reply that IS being spoken uses: Settings' mode, or 'off' when the voice in use can't use a tone. */
export function speakingToneMode(tts: Omit<ToneTtsSettings, 'enabled'>, override?: ToneVoiceOverride | null): ToneMode {
  if (tts.toneMode === 'off') return 'off'
  const v = voiceInUse(tts, override)
  return toneSupport(v.provider, v.model).ok ? tts.toneMode : 'off'
}

/**
 * The mode the AI is told about (protocols, notes): speakingToneMode, or 'off' while voice replies are off in
 * Settings — nothing is spoken then, so tags would only cost tokens.
 */
export function effectiveToneMode(tts: ToneTtsSettings, override?: ToneVoiceOverride | null): ToneMode {
  return tts.enabled ? speakingToneMode(tts, override) : 'off'
}

/** What the AI was told, as one key: 'off', or `<mode>:<placement>` (the protocols' `{{tone_instruction}}`). */
export type ToneKey = 'off' | `${Exclude<ToneMode, 'off'>}:${TonePlacement}`

export function toneKey(mode: ToneMode, placement: TonePlacement): ToneKey {
  return mode === 'off' ? 'off' : `${mode}:${placement}`
}

export function parseToneKey(k: ToneKey): { mode: ToneMode; placement: TonePlacement } {
  if (k === 'off') return { mode: 'off', placement: 'start' }
  const [mode, placement] = k.split(':') as [ToneMode, TonePlacement]
  return { mode, placement }
}

export const TONE_KEYS: readonly ToneKey[] = ['off', 'conversation:start', 'conversation:end', 'reply:start', 'reply:end']

export function isToneKey(v: unknown): v is ToneKey {
  return typeof v === 'string' && (TONE_KEYS as readonly string[]).includes(v)
}

/** The Settings / wizard choices, with one plain sentence each. */
export const TONE_MODE_OPTIONS: readonly { value: ToneMode; label: string; text: string }[] = [
  { value: 'off', label: 'Off', text: 'The voice keeps one even tone and the AI writes no tone tags.' },
  {
    value: 'conversation',
    label: 'Follow the conversation',
    text: 'The AI sets a tone when the mood of the conversation changes, and the voice keeps it from reply to reply.'
  },
  { value: 'reply', label: 'Every reply', text: 'The AI picks a fresh tone for every spoken reply.' }
]
