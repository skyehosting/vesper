/**
 * voice-client pure rules: mic modes and gating (07 D6), countdown, mic help per error (07 D8), device prefs, voice
 * options and model badges (07 C22), echo self-test verdict (07 C15), and the settings → control id map (07 D12).
 * @R12 @R19 @R20
 */
import { describe, expect, it } from 'vitest'
import { micHeldForTts } from '@shared/micGate'
import { settingsSchema } from '@shared/settings'
import type { Voice } from '@shared/types/domain'
import { countdownFor, countdownLeft, endsAfterFinal, finalAction, gateOpen, isLoopbackHost, isTypingKey, micHelp, micLabel, REARM_MS } from '../../../../src/web/features/voice/mic.logic'
import { DEFAULT_VOICE_PREFS, effectiveAutoSpeak, parseVoicePrefs } from '../../../../src/web/features/voice/prefs.logic'
import { formatMultiplier, keyLooksWrong, matchVoice, modelBadges, quotaShare, quotaText, sortVoices, voiceDetail } from '../../../../src/web/features/voice/voices.logic'
import { chirpWav, echoVerdict, effectiveCloudModel, modelProgressShare, modelProgressText } from '../../../../src/web/features/voice/voicein.logic'
import { VOICE_SETTINGS_UI } from '../../../../src/web/features/voice/settings/ids.logic'

describe('mic rules', () => {
  it('decides what a final transcript does', () => {
    const base = { autoSend: false, cancelled: false, text: 'hi', canSend: true }
    expect(finalAction({ ...base, mode: 'dictate' })).toBe('compose')
    expect(finalAction({ ...base, mode: 'dictate', autoSend: true })).toBe('send')
    expect(finalAction({ ...base, mode: 'ptt' })).toBe('send')
    expect(finalAction({ ...base, mode: 'conversation' })).toBe('send')
    expect(finalAction({ ...base, mode: 'conversation', cancelled: true })).toBe('compose')
    expect(finalAction({ ...base, mode: 'ptt', canSend: false })).toBe('compose')
    expect(finalAction({ ...base, mode: 'ptt', text: '  ' })).toBe('ignore')
    expect(endsAfterFinal('dictate')).toBe(true)
    expect(endsAfterFinal('ptt')).toBe(true)
    expect(endsAfterFinal('conversation')).toBe(false)
  })

  it('holds frames while TTS plays unless barge-in is voice; conversation re-arms after REARM_MS (07 D6)', () => {
    const g = { mode: 'conversation' as const, muted: false, ttsActive: false, bargeIn: 'tap' as const, awaitingReply: false, rearmAt: 1000, now: 1000 }
    expect(gateOpen(g)).toBe(true)
    expect(gateOpen({ ...g, now: 1000 - 1 })).toBe(false)
    expect(gateOpen({ ...g, ttsActive: true })).toBe(false)
    expect(gateOpen({ ...g, awaitingReply: true })).toBe(false)
    expect(gateOpen({ ...g, ttsActive: true, bargeIn: 'voice' })).toBe(true)
    expect(gateOpen({ ...g, muted: true, bargeIn: 'voice' })).toBe(false)
    expect(gateOpen({ ...g, mode: 'dictate', ttsActive: true })).toBe(false)
    // Push-to-talk: holding the button is an explicit "listen now".
    expect(gateOpen({ ...g, mode: 'ptt', ttsActive: true })).toBe(true)
    expect(gateOpen({ ...g, mode: 'ptt', ttsActive: true, bargeIn: 'off' })).toBe(true)
    // F36: one rule for the client gate and the STT process.
    for (const mode of ['dictate', 'ptt', 'conversation'] as const)
      for (const bargeIn of ['off', 'tap', 'voice'] as const)
        for (const ttsActive of [false, true]) {
          if (micHeldForTts({ mode, ttsActive, bargeIn })) expect(gateOpen({ ...g, mode, ttsActive, bargeIn })).toBe(false)
          else if (mode !== 'conversation') expect(gateOpen({ ...g, mode, ttsActive, bargeIn })).toBe(true)
        }
    expect(REARM_MS).toBe(250)
  })

  it('shows the countdown only for a pause (not push-to-talk, not while speaking)', () => {
    expect(countdownFor({ mode: 'dictate', speaking: false, endpointInMs: 800, now: 100 })).toEqual({ endsAt: 900, totalMs: 800 })
    expect(countdownFor({ mode: 'ptt', speaking: false, endpointInMs: 800, now: 100 })).toBeNull()
    expect(countdownFor({ mode: 'dictate', speaking: true, endpointInMs: 800, now: 100 })).toBeNull()
    expect(countdownFor({ mode: 'dictate', speaking: false, endpointInMs: undefined, now: 100 })).toBeNull()
    expect(countdownLeft({ endsAt: 900, totalMs: 800 }, 500)).toBe(0.5)
    expect(countdownLeft({ endsAt: 900, totalMs: 800 }, 2000)).toBe(0)
    expect(countdownLeft(null, 0)).toBe(0)
  })

  it('knows typing keys', () => {
    expect(isTypingKey({ key: 'a' })).toBe(true)
    expect(isTypingKey({ key: 'Backspace' })).toBe(true)
    expect(isTypingKey({ key: 'Shift' })).toBe(false)
    expect(isTypingKey({ key: 'c', ctrlKey: true })).toBe(false)
    expect(isTypingKey({ key: 'Process', isComposing: true })).toBe(true)
  })

  it('gives specific help per failure (07 D8): HTTPS on LAN http, Windows privacy, denied', () => {
    const lan = { isSecureContext: false, protocol: 'http:', hostname: '192.168.1.50', desktop: false, windows: true }
    const h = micHelp('insecure_context', lan)
    expect(h.title).toBe('Voice input needs HTTPS')
    expect(h.body).toContain('192.168.1.50')
    expect(h.steps.join(' ')).toContain('Local network (HTTPS)')
    const win = micHelp('mic_os_blocked', { ...lan, isSecureContext: true, desktop: true })
    expect(win.action).toBe('open-windows-privacy')
    expect(win.steps.join(' ')).toContain('Privacy & security → Microphone')
    expect(micHelp('mic_denied', lan).steps.join(' ')).toContain('address bar')
    expect(micHelp('stt_model_missing', lan).action).toBe('settings-voice-in')
    expect(isLoopbackHost('vesper.localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
  })

  it('labels the button per state', () => {
    expect(micLabel({ mode: 'dictate', state: 'idle', countdown: null, insecure: false })).toBe('Dictate')
    expect(micLabel({ mode: 'ptt', state: 'idle', countdown: null, insecure: false })).toBe('Hold to talk')
    expect(micLabel({ mode: 'conversation', state: 'listening', countdown: null, insecure: false })).toBe('End conversation')
    expect(micLabel({ mode: 'dictate', state: 'listening', countdown: 'send', insecure: false })).toBe('Send now')
    expect(micLabel({ mode: 'dictate', state: 'idle', countdown: null, insecure: true })).toBe('Voice input needs HTTPS')
  })
})

describe('device prefs', () => {
  it('parses defensively and follows the setting when unset', () => {
    expect(parseVoicePrefs(null)).toEqual(DEFAULT_VOICE_PREFS)
    expect(parseVoicePrefs('{bad')).toEqual(DEFAULT_VOICE_PREFS)
    expect(parseVoicePrefs('[1]')).toEqual(DEFAULT_VOICE_PREFS)
    const p = parseVoicePrefs(JSON.stringify({ autoSpeak: false, micDeviceId: 'abc', echoCancellation: 'yes', echoTest: { passed: true, at: 5, ratio: 1.2 } }))
    expect(p).toMatchObject({ autoSpeak: false, micDeviceId: 'abc', echoCancellation: true, echoTest: { passed: true, at: 5, ratio: 1.2 } })
    expect(effectiveAutoSpeak({ autoSpeak: null }, true)).toBe(true)
    expect(effectiveAutoSpeak({ autoSpeak: false }, true)).toBe(false)
  })
})

describe('voice out helpers', () => {
  const voices: Voice[] = [
    { id: 'c', name: 'Clone', provider: 'elevenlabs', category: 'cloned', previewable: false },
    { id: 'r', name: 'Rowan', provider: 'elevenlabs', category: 'premade', language: 'en', gender: 'male', previewable: true },
    { id: 'a', name: 'Aria', provider: 'elevenlabs', category: 'premade', previewable: true },
    { id: 'z', name: 'Microsoft Zira', provider: 'windows', previewable: true }
  ]
  it('sorts premade first and matches /voice names', () => {
    expect(sortVoices(voices).map((v) => v.id)).toEqual(['a', 'r', 'z', 'c'])
    expect(matchVoice(voices, 'aria')?.id).toBe('a')
    expect(matchVoice(voices, 'row')?.id).toBe('r')
    expect(matchVoice(voices, 'zira')?.id).toBe('z')
    expect(matchVoice(voices, 'lon')?.id).toBe('c')
    expect(matchVoice(voices, 'nobody')).toBeNull()
    expect(voiceDetail(voices[1])).toBe('premade · en · male')
  })
  it('badges models with price and speed (07 C22)', () => {
    expect(modelBadges({ id: 'f', costMultiplier: 0.5, fast: true }, 0.5).map((b) => b.text)).toEqual(['½× price', 'Fast'])
    expect(modelBadges({ id: 'v', costMultiplier: 1, audioTags: true }, 0.5).map((b) => b.text)).toEqual(['1× price', 'Tone tags'])
    expect(modelBadges({ id: 'x', costMultiplier: 1 }, 1).map((b) => b.text)).toEqual(['Lowest price'])
    expect(formatMultiplier(0.3)).toBe('0.3×')
    expect(quotaText({ used: 1234, limit: 100_000 })).toBe('98,766 of 100,000 characters left')
    expect(quotaShare({ used: 0, limit: 0 })).toBeNull()
    expect(keyLooksWrong('openai', 'abcdefghijk')).toMatch(/sk-/)
    expect(keyLooksWrong('elevenlabs', 'abc')).toMatch(/short/)
    expect(keyLooksWrong('elevenlabs', 'sk_1234567890')).toBeNull()
  })
})

describe('voice in helpers', () => {
  it('reads model progress', () => {
    const fmt = (n: number): string => `${Math.round(n / 1e6)} MB`
    expect(modelProgressText({ state: 'downloading', progress: { bytes: 212e6, total: 487e6 }, downloadBytes: 487e6 }, fmt)).toBe('212 MB of 487 MB')
    expect(modelProgressText({ state: 'verifying', downloadBytes: 1 }, fmt)).toBe('Checking the download…')
    expect(modelProgressShare({ state: 'downloading', progress: { bytes: 50, total: 100 }, downloadBytes: 100 })).toBe(0.5)
    expect(modelProgressShare({ state: 'extracting', downloadBytes: 100 })).toBeUndefined()
    expect(effectiveCloudModel('groq', 'parakeet-tdt-0.6b-v3-int8')).toBe('whisper-large-v3-turbo')
    expect(effectiveCloudModel('openai', 'whisper-1')).toBe('whisper-1')
  })
  it('makes a valid chirp WAV and judges the echo test', () => {
    const wav = new DataView(chirpWav(500, 8000))
    expect(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3))).toBe('RIFF')
    expect(wav.getUint32(40, true)).toBe(4000 * 2)
    expect(wav.byteLength).toBe(44 + 8000)
    expect(echoVerdict([0.01, 0.01, 0.012], [0.012, 0.015, 0.011, 0.013]).passed).toBe(true)
    const loud = echoVerdict([0.01, 0.01], [0.2, 0.25, 0.3, 0.22])
    expect(loud.passed).toBe(false)
    expect(loud.ratio).toBeGreaterThan(10)
    expect(echoVerdict([0.01], []).passed).toBe(false)
  })
})

describe('settings → control ids (07 D12)', () => {
  it('maps every voice settings leaf to a control id', () => {
    const leaves: string[] = []
    const walk = (o: unknown, path: string): void => {
      if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k)
      else leaves.push(path)
    }
    walk(settingsSchema.parse({}).voice, 'voice')
    expect(leaves.length).toBeGreaterThan(30)
    for (const leaf of leaves) expect(VOICE_SETTINGS_UI, leaf).toHaveProperty([leaf])
    expect(new Set(Object.values(VOICE_SETTINGS_UI)).size).toBe(Object.keys(VOICE_SETTINGS_UI).length)
  })
})
