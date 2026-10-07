import { describe, expect, it } from 'vitest'
import { baseUrlProblem, defaultSettings, migrateLegacyStarStyle, settingsSchema } from '@shared/settings'
import { salvageSettings } from '../../../src/server/settings/store'

describe('settings schema', () => {
  it('produces complete defaults', () => {
    const s = defaultSettings()
    expect(s.chat.pageSize).toBe(100)
    expect(s.chat.attachments.maxFileMb).toBe(25)
    expect(s.voice.stt.silenceMs).toBe(1200)
    expect(s.voice.tts.tonePlacement).toBe('start')
    expect(s.voice.tts.perDevice).toBe('sender')
    expect(s.access.port).toBe(41730)
    expect(s.memory.scopeDefault).toBe('linked')
    expect(s.memory.voyage.embedModel).toBe('voyage-4-lite')
    expect(s.appearance.star.style).toBe('armilla')
    expect(s.desktop.startWithWindows).toBe(false)
    expect(s.data.backups).toBe(true)
  })

  it('v1.1: a 1.0 settings file that kept the 1.0 default style (orb) gets Armilla once; a 1.1 file keeps its choice', () => {
    const v10 = { voice: { tts: { tone: true } }, appearance: { star: { style: 'orb', quality: 'high' } } }
    expect(salvageSettings(v10).settings.appearance.star).toMatchObject({ style: 'armilla', quality: 'high' })
    expect(salvageSettings(v10).settings.voice.tts.toneMode).toBe('conversation')
    // 1.0 with another style chosen, and 1.1 files (toneMode written), keep what they have.
    expect(salvageSettings({ voice: { tts: { tone: false } }, appearance: { star: { style: 'nebula' } } }).settings.appearance.star.style).toBe('nebula')
    expect(salvageSettings({ voice: { tts: { toneMode: 'off' } }, appearance: { star: { style: 'orb' } } }).settings.appearance.star.style).toBe('orb')
    expect(migrateLegacyStarStyle(null)).toBeNull()
  })

  it('fills nested defaults from a partial object', () => {
    const s = settingsSchema.parse({ voice: { tts: { enabled: true } } })
    expect(s.voice.tts.enabled).toBe(true)
    expect(s.voice.tts.speed).toBe(1)
    expect(s.voice.stt.silenceMs).toBe(1200)
  })

  it('rejects out-of-range values', () => {
    expect(() => settingsSchema.parse({ chat: { pageSize: 5000 } })).toThrow()
    expect(() => settingsSchema.parse({ voice: { stt: { silenceMs: 50 } } })).toThrow()
  })

  it('validates base URLs (07 B1)', () => {
    expect(baseUrlProblem('https://api.openai.com/v1')).toBeNull()
    expect(baseUrlProblem('http://localhost:11434/v1')).toBeNull()
    expect(baseUrlProblem('http://127.0.0.1:1234/v1')).toBeNull()
    expect(baseUrlProblem('http://192.168.1.20:8000/v1')).toMatch(/https/)
    expect(baseUrlProblem('https://user:pw@evil.example/v1')).toMatch(/user name/)
    expect(baseUrlProblem('https://api.example.com/v1?x=1')).toMatch(/query/)
    expect(baseUrlProblem('file:///etc/passwd')).toMatch(/https/)
    expect(baseUrlProblem('http://192.168.1.20:8000/v1', ['192.168.1.20'])).toBeNull()
  })
})
