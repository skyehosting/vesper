/**
 * Protocols file → the frozen system text of an epoch (07 C1). The user-editable copy lives at
 * `<roaming>/protocols.md` (content-server owns GET/PUT/reset); the shipped default is bundled. Rendering happens ONLY
 * at epoch start and the result is stored in `epochs.system_json`, so edits, renames and app updates reach the model
 * at the next epoch, never mid-epoch. No clock, no per-turn state in here.
 */
import fs from 'node:fs'
import path from 'node:path'
import { functionDocsNative, functionDocsText } from '@shared/memoryFunctions'
import type { ToolMode } from '@shared/types/domain'
import { parseToneKey, TONE_KEYS, type ToneKey, type ToneMode, type TonePlacement } from '@shared/voiceTone'
import DEFAULT_PROTOCOLS from '@shared/protocols.default.md?raw'
import { sha16 } from '../providers/llm/render'

export { DEFAULT_PROTOCOLS }

export const PROTOCOLS_FILE = 'protocols.md'

/** Suggested tone words for `{{tones}}` (free-form tags are allowed; voice-out maps them per provider). */
export const TONE_SUGGESTIONS = ['warm', 'calm', 'playful', 'gentle', 'excited', 'serious', 'thoughtful', 'sad', 'whispering']

export function readProtocols(roamingDir: string): { text: string; hash: string } {
  let text = DEFAULT_PROTOCOLS
  try {
    const file = path.join(roamingDir, PROTOCOLS_FILE)
    if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8')
  } catch {
    text = DEFAULT_PROTOCOLS
  }
  return { text, hash: sha16(text) }
}

export interface ProtocolVars {
  assistantName: string
  userName: string
  sessionShortId: string
  toolMode: ToolMode
  /**
   * The tone mode in force (H-v11-tone: voice.tts.toneMode, 'off' when the voice in use can't use a tone — see
   * effectiveToneMode) and where the tag goes (07 A2).
   */
  toneMode: ToneMode
  tonePlacement: TonePlacement
}

const TONE_EXAMPLE = '`[tone=warm, gently teasing]`'
const TAG_HIDDEN = 'Tone tags are never shown or spoken.'

/** The sentence that says when to write a tag; old epochs are recognised by it (frozenToneKey). */
function whenToTag(mode: Exclude<ToneMode, 'off'>, placement: TonePlacement): string {
  const where = placement === 'start' ? 'Start' : 'End'
  // 'reply' is Vesper 1.0.0's wording, byte for byte.
  if (mode === 'reply') return `${where} every spoken reply with one tone tag describing how it should sound, like ${TONE_EXAMPLE} (a few plain words).`
  const at = placement === 'start' ? 'at the start of that reply' : 'at the end of that reply'
  return (
    `Your voice keeps one tone across the conversation. ${where} your first spoken reply with one tone tag describing how ` +
    `you should sound, like ${TONE_EXAMPLE} (a few plain words). After that, write a new tone tag (${at}) only when the ` +
    'emotional tone of the conversation really shifts; otherwise write no tag at all and the current tone carries on.'
  )
}

/**
 * `{{tone_instruction}}` (07 A2, H-v11-tone): when to write a tone tag, the suggested tones and that tags stay hidden —
 * or, with tones off (or a voice that can't use them), one short sentence and nothing else.
 */
export function toneInstruction(v: Pick<ProtocolVars, 'toneMode' | 'tonePlacement'>): string {
  if (v.toneMode === 'off') return 'Do not write tone tags.'
  return `${whenToTag(v.toneMode, v.tonePlacement)} Choose from tones like these: ${TONE_SUGGESTIONS.join(', ')}. ${TAG_HIDDEN}`
}

/**
 * The system_note for a tone change inside an epoch (07 C1: the frozen system is never re-rendered). `why` says why
 * tones are now off: the owner turned them off, the voice in use can't use a tone, or voice replies are off.
 */
export function toneChangeNote(k: ToneKey, userName: string, why: 'setting' | 'voice' | 'voice-off' = 'setting'): string {
  const { mode, placement } = parseToneKey(k)
  if (mode === 'off') {
    if (why === 'voice') return 'The voice now in use can’t change its tone: from now on, do not write tone tags.'
    if (why === 'voice-off') return 'Voice replies are turned off in Settings: from now on, do not write tone tags.'
    return `${userName} turned voice tones off: from now on, do not write tone tags.`
  }
  const where = placement === 'start' ? 'Start' : 'End'
  if (mode === 'reply') return `Voice tones are set per reply now: ${toneInstruction({ toneMode: mode, tonePlacement: placement }).replace(/^./, (c) => c.toLowerCase())}`
  const at = placement === 'start' ? 'at the start of that reply' : 'at the end of that reply'
  return (
    `Voice tones now follow the conversation: ${where.toLowerCase()} your next spoken reply with one tone tag like ${TONE_EXAMPLE}. ` +
    `After that, write a new tone tag (${at}) only when the emotional tone of the conversation really shifts; otherwise ` +
    `write no tag and the current tone carries on. ${TAG_HIDDEN}`
  )
}

/**
 * What an epoch's frozen system told the AI about tones, read back from its text (null when the protocols have no
 * `{{tone_instruction}}`). Lets the first turn of an epoch, and chats from before toneMode existed, notice a change.
 */
export function frozenToneKey(systemJson: string): ToneKey | null {
  let text = ''
  try {
    const parts = JSON.parse(systemJson) as Array<{ text?: unknown }>
    text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).join('\n')
  } catch {
    return null
  }
  if (text.includes(toneInstruction({ toneMode: 'off', tonePlacement: 'start' }))) return 'off'
  for (const k of TONE_KEYS) {
    const { mode, placement } = parseToneKey(k)
    if (mode !== 'off' && text.includes(whenToTag(mode, placement))) return k
  }
  return null
}

/** Fill placeholders and keep only the active mode block. Unknown `{{…}}` stay as written. */
export function renderProtocols(src: string, v: ProtocolVars): string {
  const keep = v.toolMode === 'native' ? 'native_mode' : 'text_mode'
  const drop = v.toolMode === 'native' ? 'text_mode' : 'native_mode'
  let out = src
    .replace(new RegExp(`\\{\\{#${drop}\\}\\}[\\s\\S]*?\\{\\{/${drop}\\}\\}\\n?`, 'g'), '')
    .replace(new RegExp(`\\{\\{#${keep}\\}\\}\\n?([\\s\\S]*?)\\{\\{/${keep}\\}\\}\\n?`, 'g'), '$1')
  const vars: Record<string, string> = {
    assistant_name: v.assistantName || 'Vesper',
    user_name: v.userName || 'the user',
    session_id: `#${v.sessionShortId}`,
    tones: TONE_SUGGESTIONS.join(', '),
    tone_instruction: toneInstruction(v),
    native_function_docs: functionDocsNative(),
    text_function_docs: functionDocsText()
  }
  out = out.replace(/\{\{([a-z_]+)\}\}/g, (m, name: string, at: number, all: string) => {
    const v = vars[name] ?? m
    // "the user" at the start of a sentence reads "The user".
    return /(^|[.!?]\s+|\n\s*)$/.test(all.slice(Math.max(0, at - 3), at)) && v.startsWith('the ') ? `T${v.slice(1)}` : v
  })
  return out.replace(/\n{3,}/g, '\n\n').trim()
}
