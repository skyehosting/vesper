/**
 * `/voice tone …` argument parsing and completion (H-v11-tone), pure and unit-tested; toneCommand.ts runs it.
 */
import { TONE_MODE_OPTIONS, type ToneMode } from '@shared/voiceTone'
import type { ArgSuggestion } from '../../lib/commands/registry.logic'

/** Words accepted for each mode (the first is the documented one). */
const WORDS: Record<ToneMode, readonly string[]> = {
  off: ['off', 'none', 'no'],
  conversation: ['conversation', 'follow', 'auto', 'on'],
  reply: ['reply', 'every', 'each', 'per-reply']
}

/** `tone …` → the mode asked for; null when the argument is not a tone command; 'show' for a bare `tone`. */
export function parseToneArg(args: string): ToneMode | 'show' | 'unknown' | null {
  const m = /^tones?(?:\s+(.*))?$/i.exec(args.trim())
  if (!m) return null
  const word = (m[1] ?? '').trim().toLowerCase()
  if (!word) return 'show'
  for (const [mode, words] of Object.entries(WORDS) as [ToneMode, readonly string[]][]) if (words.includes(word)) return mode
  return 'unknown'
}

export const TONE_ARG_SUGGESTIONS: readonly ArgSuggestion[] = TONE_MODE_OPTIONS.map((o) => ({
  insert: `tone ${WORDS[o.value][0]}`,
  label: `tone ${WORDS[o.value][0]} — voice tones: ${o.label.toLowerCase()}`,
  final: true
}))
