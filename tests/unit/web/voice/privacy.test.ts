/**
 * F20: the voice-out privacy text comes from one helper (src/shared/privacy.ts `ttsDisclosure`) for Voice settings,
 * the wizard and Settings → Privacy, and an OpenAI-compatible server is never described with OpenAI's terms. @R21
 */
import { describe, expect, it } from 'vitest'
import { disclosure, isLoopbackUrl, ttsDisclosure } from '@shared/privacy'
import { baseUrlProblem, settingsSchema, type PublicSettings } from '@shared/settings'
import { llmDisclosureId } from '@shared/privacy'
import { servicesInUse } from '../../../../src/web/features/privacy/privacy.logic'
import { providerMeta } from '../../../../src/web/features/voice/voices.logic'

describe('voice-out privacy text (07 B13, F20) @R21', () => {
  it('an OpenAI-compatible server never gets OpenAI’s "not used for training" text', () => {
    for (const url of ['http://127.0.0.1:8880/v1', 'http://localhost:5002/v1', 'http://[::1]:9000/v1', 'https://tts.example.com/v1', 'https://api.openai.com/v1', '']) {
      const d = ttsDisclosure('openai-compatible', url)
      expect(d.id).not.toBe('openai-tts')
      expect(d.summary).not.toMatch(/not used for training/i)
      expect(d.service).not.toMatch(/OpenAI/)
      expect(d.sources.some((s) => /openai\.com/.test(s))).toBe(false)
    }
    expect(providerMeta('openai-compatible').disclosure).not.toBe('openai-tts')
  })

  it('on this PC: local unless the server forwards; anywhere else: unknown', () => {
    const local = ttsDisclosure('openai-compatible', 'http://127.0.0.1:8880/v1')
    expect(local).toMatchObject({ id: 'tts-local', training: 'local' })
    expect(local.summary).toMatch(/unless that server itself passes it on/)
    const remote = ttsDisclosure('openai-compatible', 'https://tts.example.com/v1')
    expect(remote).toMatchObject({ id: 'tts-custom', training: 'unknown', service: 'tts.example.com' })
    expect(remote.summary).toMatch(/can't tell/)
    expect(isLoopbackUrl('http://evil.localhost.example.com/')).toBe(false)
  })

  it('a remote host that only starts with "127." is not this PC (one strict loopback rule everywhere)', () => {
    for (const url of ['https://127.voice-cloud.net/v1', 'https://127.0.0.1.example.com/v1', 'https://127.0.0.1.nip.io/v1']) {
      expect(isLoopbackUrl(url)).toBe(false)
      expect(ttsDisclosure('openai-compatible', url)).toMatchObject({ id: 'tts-custom', training: 'unknown' })
      expect(llmDisclosureId('custom', url)).toBe('llm.custom')
      expect(baseUrlProblem(url.replace('https:', 'http:'))).toMatch(/only allowed for this PC/)
    }
    for (const url of ['http://127.0.0.1:8880/v1', 'http://127.1.2.3/v1', 'http://[::1]:9000/v1', 'http://localhost/v1', 'http://tts.localhost/v1']) {
      expect(isLoopbackUrl(url)).toBe(true)
      expect(baseUrlProblem(url)).toBeNull()
      expect(llmDisclosureId('custom', url)).toBe('llm.local-custom') // 07 H-cs-2: a custom program on this PC may still forward requests online
    }
  })

  it('the named providers keep their verified entries', () => {
    expect(ttsDisclosure('openai', '')).toBe(disclosure('openai-tts'))
    expect(ttsDisclosure('elevenlabs', '')).toBe(disclosure('elevenlabs'))
    expect(ttsDisclosure('windows', '')).toBe(disclosure('windows-voices'))
    expect(ttsDisclosure('piper', '')).toMatchObject({ id: 'piper', training: 'local' })
  })

  it('Settings → Privacy shows the same text as Voice settings', () => {
    for (const baseUrl of ['http://127.0.0.1:8880/v1', 'https://tts.example.com/v1']) {
      const s = settingsSchema.parse({}) as unknown as PublicSettings
      s.voice.tts.enabled = true
      s.voice.tts.provider = 'openai-compatible'
      s.voice.tts.baseUrl = baseUrl
      const row = servicesInUse(s, []).find((x) => x.group === 'voice-out')!
      expect(row.disclosure).toEqual(ttsDisclosure('openai-compatible', baseUrl))
    }
  })
})
