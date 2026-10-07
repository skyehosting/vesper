/** Protocols → frozen system text (07 C1): placeholders, one mode block, no clock. */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROTOCOLS, frozenToneKey, renderProtocols, toneChangeNote, toneInstruction } from '@server/chat/protocols'
import { TONE_KEYS, parseToneKey } from '@shared/voiceTone'

const base = { assistantName: 'Nova', userName: 'Sam', sessionShortId: 'K7Q2MX', toolMode: 'native' as const, toneMode: 'reply' as const, tonePlacement: 'start' as const }

describe('renderProtocols @R9 @R11 @R13', () => {
  it('fills every placeholder of the default file and keeps only the active mode', () => {
    const native = renderProtocols(DEFAULT_PROTOCOLS, base)
    expect(native).not.toMatch(/\{\{/)
    expect(native).toContain('You are Nova, talking with Sam')
    expect(native).toContain('`#K7Q2MX`')
    expect(native).toContain('You have these memory tools')
    expect(native).not.toContain('alone on its own line')
    expect(native).toContain('Start every spoken reply with one tone tag')
    const text = renderProtocols(DEFAULT_PROTOCOLS, { ...base, toolMode: 'text' })
    expect(text).toContain('alone on its own line')
    expect(text).toContain('[memory_search query=')
    expect(text).not.toContain('You have these memory tools')
  })

  it('is deterministic and has no clock', () => {
    expect(renderProtocols(DEFAULT_PROTOCOLS, base)).toBe(renderProtocols(DEFAULT_PROTOCOLS, base))
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'))
    const later = renderProtocols(DEFAULT_PROTOCOLS, base)
    vi.useRealTimers()
    expect(later).toBe(renderProtocols(DEFAULT_PROTOCOLS, base))
    expect(later).not.toContain('2031')
  })

  it('reads "The user" at a sentence start when no name is set', () => {
    const out = renderProtocols('Hello {{user_name}}. {{user_name}} likes tea.\n{{user_name}} too.', { ...base, userName: '' })
    expect(out).toBe('Hello the user. The user likes tea.\nThe user too.')
  })

  it('tone instruction follows the setting (07 A2)', () => {
    expect(toneInstruction({ toneMode: 'reply', tonePlacement: 'end' })).toMatch(/^End every spoken reply/)
    expect(toneInstruction({ toneMode: 'off', tonePlacement: 'start' })).toBe('Do not write tone tags.')
  })
})

describe('tone modes (H-v11-tone) @R13', () => {
  it("'reply' keeps 1.0.0's sentence; 'conversation' asks for a tag only when the conversation's tone shifts", () => {
    const reply = toneInstruction({ toneMode: 'reply', tonePlacement: 'start' })
    expect(reply).toContain('Start every spoken reply with one tone tag describing how it should sound, like `[tone=warm, gently teasing]` (a few plain words).')
    expect(reply).toContain('Choose from tones like these: warm, calm')
    expect(reply).toContain('Tone tags are never shown or spoken.')
    const conv = toneInstruction({ toneMode: 'conversation', tonePlacement: 'start' })
    expect(conv).not.toMatch(/every spoken reply/i)
    expect(conv).toMatch(/Start your first spoken reply with one tone tag/)
    expect(conv).toMatch(/only when the emotional tone of the conversation really shifts; otherwise write no tag at all and the current tone carries on/)
    expect(conv).toContain('at the start of that reply')
    expect(toneInstruction({ toneMode: 'conversation', tonePlacement: 'end' })).toMatch(/End your first spoken reply[\s\S]*at the end of that reply/)
  })

  it("'off' (or a voice that can't use tones) costs one short sentence: no tag syntax, no tone list", () => {
    const off = renderProtocols(DEFAULT_PROTOCOLS, { ...base, toneMode: 'off' })
    expect(off).toContain('Do not write tone tags.')
    expect(off).not.toContain('[tone=')
    expect(off).not.toContain('Choose from tones')
    const conv = renderProtocols(DEFAULT_PROTOCOLS, { ...base, toneMode: 'conversation' })
    expect(conv).toContain('[tone=warm, gently teasing]')
    expect(conv.length).toBeGreaterThan(off.length)
  })

  it('the frozen system says which instruction an epoch started with — also for 1.0.0 epochs', () => {
    for (const k of TONE_KEYS) {
      const { mode, placement } = parseToneKey(k)
      const sys = JSON.stringify([{ text: renderProtocols(DEFAULT_PROTOCOLS, { ...base, toneMode: mode, tonePlacement: placement }) }])
      expect(frozenToneKey(sys), k).toBe(k)
    }
    // Vesper 1.0.0's default protocols rendered the 'reply' sentence followed by its own tone list.
    const old = 'Write for the ear. Start every spoken reply with one tone tag describing how it should sound, like `[tone=warm, gently teasing]` (a few plain words). Choose from these tones:\nwarm, calm. Tone tags are never shown or spoken.'
    expect(frozenToneKey(JSON.stringify([{ text: old }]))).toBe('reply:start')
    expect(frozenToneKey(JSON.stringify([{ text: '# Protocols\nYou are Vesper.' }]))).toBeNull()
    expect(frozenToneKey('not json')).toBeNull()
  })

  it('a change inside an epoch is a note that says what to do from now on', () => {
    expect(toneChangeNote('off', 'Sam')).toBe('Sam turned voice tones off: from now on, do not write tone tags.')
    expect(toneChangeNote('off', 'Sam', 'voice')).toMatch(/can’t change its tone/)
    expect(toneChangeNote('off', 'Sam', 'voice-off')).toMatch(/Voice replies are turned off/)
    expect(toneChangeNote('conversation:start', 'Sam')).toMatch(/^Voice tones now follow the conversation: start your next spoken reply with one tone tag/)
    expect(toneChangeNote('reply:end', 'Sam')).toMatch(/^Voice tones are set per reply now: end every spoken reply with one tone tag/)
  })
})
