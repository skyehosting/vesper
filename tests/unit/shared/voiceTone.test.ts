/**
 * Voice tone modes (H-v11-tone, 07 A2, R13): which voices can use a tone, the mode in force, the migration from
 * Vesper 1.0.0's `voice.tts.tone` boolean (settings files and PATCH bodies), `/voice tone …`, and the chat's tone key.
 * @R13
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings, migrateSettingsInput, settingsSchema } from '@shared/settings'
import { effectiveToneMode, migrateToneSettings, speakingToneMode, TONE_MODE_OPTIONS, toneKey, toneSupport, voiceInUse } from '@shared/voiceTone'
import { createSettingsStore, salvageSettings } from '@server/settings/store'
import { toneKeyOf } from '@server/chat/context'
import { createLog } from '@server/log'
import { parseToneArg, TONE_ARG_SUGGESTIONS } from '../../../src/web/features/voice/toneCommand.logic'

const log = createLog({ dir: path.join(os.tmpdir(), 'vesper-tone-log') })
const tts = (o: Partial<Parameters<typeof effectiveToneMode>[0]> = {}) => ({ enabled: true, provider: 'elevenlabs', model: null, toneMode: 'conversation' as const, ...o })

describe('which voices can use a tone', () => {
  it('ElevenLabs (every model), OpenAI gpt-4o models, a compatible server running gpt-4o, Windows voices', () => {
    expect(toneSupport('elevenlabs', 'eleven_v4').ok).toBe(true)
    expect(toneSupport('elevenlabs', 'eleven_flash_v2_5').ok).toBe(true)
    expect(toneSupport('elevenlabs', null).ok).toBe(true)
    expect(toneSupport('openai', 'gpt-4o-mini-tts').ok).toBe(true)
    expect(toneSupport('openai', null).ok).toBe(true) // OpenAI's default model is gpt-4o-mini-tts
    expect(toneSupport('openai', 'tts-1').ok).toBe(false)
    expect(toneSupport('openai', 'tts-1-hd').text).toMatch(/gpt-4o-mini-tts/)
    expect(toneSupport('openai-compatible', null).ok).toBe(false) // its default is tts-1
    expect(toneSupport('openai-compatible', 'gpt-4o-mini-tts').ok).toBe(true)
    expect(toneSupport('windows', null).ok).toBe(true)
    expect(toneSupport('piper', null).ok).toBe(false)
  })

  it("the mode in force is 'off' with tones off, voice replies off (for the AI), or a voice without tones", () => {
    expect(effectiveToneMode(tts())).toBe('conversation')
    expect(effectiveToneMode(tts({ toneMode: 'reply' }))).toBe('reply')
    expect(effectiveToneMode(tts({ toneMode: 'off' }))).toBe('off')
    expect(effectiveToneMode(tts({ enabled: false }))).toBe('off')
    expect(speakingToneMode(tts({ enabled: false }))).toBe('conversation') // a reply that IS spoken still uses it
    expect(effectiveToneMode(tts({ provider: 'openai', model: 'tts-1' }))).toBe('off')
  })

  it("a chat's own voice decides (R12 override), with its model or Settings' model of the same provider", () => {
    const base = tts({ provider: 'openai', model: 'tts-1' })
    expect(voiceInUse(base, { provider: 'elevenlabs', voiceId: 'v' })).toEqual({ provider: 'elevenlabs', model: null })
    expect(voiceInUse(base, { provider: 'openai', voiceId: 'alloy' })).toEqual({ provider: 'openai', model: 'tts-1' })
    expect(effectiveToneMode(base, { provider: 'elevenlabs', voiceId: 'v' })).toBe('conversation')
    expect(effectiveToneMode(tts(), { provider: 'openai', voiceId: 'alloy', model: 'tts-1' })).toBe('off')
    const s = defaultSettings()
    s.voice.tts.enabled = true
    expect(toneKeyOf(s, { voice: null })).toBe('conversation:start')
    s.voice.tts.tonePlacement = 'end'
    expect(toneKeyOf(s, { voice: null })).toBe('conversation:end')
    expect(toneKeyOf(s, { voice: { provider: 'openai-compatible', voiceId: 'x' } })).toBe('off')
    expect(toneKey('off', 'end')).toBe('off')
  })

  it('every mode has one plain sentence for Settings and the wizard', () => {
    expect(TONE_MODE_OPTIONS.map((o) => o.label)).toEqual(['Off', 'Follow the conversation', 'Every reply'])
    for (const o of TONE_MODE_OPTIONS) expect(o.text.match(/[.!?](\s|$)/g), o.value).toHaveLength(1)
  })
})

describe("migration from 1.0.0's voice.tts.tone boolean", () => {
  it("defaults to 'conversation'; false → 'off', true → 'conversation'; an explicit toneMode wins", () => {
    expect(defaultSettings().voice.tts.toneMode).toBe('conversation')
    expect('tone' in defaultSettings().voice.tts).toBe(false)
    expect(migrateToneSettings({ tone: false, speed: 1 })).toEqual({ toneMode: 'off', speed: 1 })
    expect(migrateToneSettings({ tone: true })).toEqual({ toneMode: 'conversation' })
    expect(migrateToneSettings({ tone: false, toneMode: 'reply' })).toEqual({ toneMode: 'reply' })
    expect(migrateToneSettings({ tone: 'x' })).toEqual({})
    const plain = { speed: 1 }
    expect(migrateToneSettings(plain)).toBe(plain)
    expect(migrateSettingsInput({ chat: { pageSize: 100 } })).toEqual({ chat: { pageSize: 100 } })
    expect(migrateSettingsInput(null)).toBeNull()
    expect(settingsSchema.parse(migrateSettingsInput({ voice: { tts: { tone: false } } })).voice.tts.toneMode).toBe('off')
  })

  it('an old settings.json is read without "repairs", and written back with toneMode only', async () => {
    const r = salvageSettings({ voice: { tts: { tone: false, tonePlacement: 'end' } } })
    expect(r.dropped).toEqual([])
    expect(r.settings.voice.tts.toneMode).toBe('off')
    expect(r.settings.voice.tts.tonePlacement).toBe('end')

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-tone-'))
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ voice: { tts: { enabled: true, tone: false } } }))
    const s = await createSettingsStore(file, log)
    expect(s.recovery).toBeNull()
    expect(s.get().voice.tts.toneMode).toBe('off')
    // A PATCH from an older client that still sends the boolean.
    await s.patch({ voice: { tts: { tone: true } } } as never)
    expect(s.get().voice.tts.toneMode).toBe('conversation')
    await s.patch({ voice: { tts: { toneMode: 'reply' } } })
    await s.flush()
    const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as { voice: { tts: Record<string, unknown> } }
    expect(disk.voice.tts.toneMode).toBe('reply')
    expect(disk.voice.tts.tone).toBeUndefined()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('/voice tone …', () => {
  it('parses the three modes (and a few natural words), a bare "tone", and leaves voice names alone', () => {
    expect(parseToneArg('tone off')).toBe('off')
    expect(parseToneArg('tone conversation')).toBe('conversation')
    expect(parseToneArg('Tones Follow')).toBe('conversation')
    expect(parseToneArg('tone reply')).toBe('reply')
    expect(parseToneArg('tone every')).toBe('reply')
    expect(parseToneArg('tone')).toBe('show')
    expect(parseToneArg('tone loud')).toBe('unknown')
    expect(parseToneArg('Tonetta')).toBeNull()
    expect(parseToneArg('on')).toBeNull()
    expect(parseToneArg('')).toBeNull()
    expect(TONE_ARG_SUGGESTIONS.map((x) => x.insert)).toEqual(['tone off', 'tone conversation', 'tone reply'])
  })
})
