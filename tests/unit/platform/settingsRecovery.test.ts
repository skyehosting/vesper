/**
 * Phase 4b F59: a corrupt settings.json (trailing comma, zero-length, truncated) was silently replaced by defaults with
 * no copy, and the first-run wizard ran again. Now the damaged bytes are always kept (settings.json.bad-<stamp>), the
 * last saved copy (settings.json.bak) is used when there is one, and the recovery reaches the owner through
 * Bootstrap.health (the desktop then opens Settings, not the wizard). @R4 @R20
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createSettingsStore, KEEP_BAD_COPIES } from '@server/settings/store'
import { healthNotices } from '../../../src/web/features/health/health.logic'
import { fakeLog, removeTempDir, tempDir } from '../../fakes'
import { startTestServer } from '../server/helpers'

const made: string[] = []
afterAll(() => {
  for (const d of made) removeTempDir(d)
})
function dir(): string {
  const d = tempDir('vesper-setrec-')
  made.push(d)
  return d
}
const badCopies = (d: string) => fs.readdirSync(d).filter((n) => n.startsWith('settings.json.bad-'))

const GOOD = { wizard: { completed: true }, chat: { pageSize: 150 } }

describe('a damaged settings.json without a saved copy', () => {
  for (const [name, text] of [
    ['one trailing comma', `{ "wizard": { "completed": true }, "chat": { "pageSize": 150 }, }`],
    ['a zero-length file', ''],
    ['a truncated file', JSON.stringify(GOOD, null, 2).slice(0, 30)]
  ] as const) {
    it(`${name}: the original bytes are kept (and survive later saves); recovery = reset`, async () => {
      const d = dir()
      const file = path.join(d, 'settings.json')
      fs.writeFileSync(file, text)
      const s = await createSettingsStore(file, fakeLog(), { now: () => new Date(2026, 9, 5, 14, 3, 9).getTime() })
      expect(s.get().wizard.completed).toBe(false)
      expect(s.recovery).toMatchObject({ kind: 'reset', copy: 'settings.json.bad-20261005-140309', dropped: [] })
      expect(fs.readFileSync(path.join(d, 'settings.json.bad-20261005-140309'), 'utf8')).toBe(text)
      // The automatic port / voiceId patches used to overwrite the only copy.
      await s.patch({ access: { port: 47999 } })
      await s.flush()
      expect(fs.readFileSync(path.join(d, 'settings.json.bad-20261005-140309'), 'utf8')).toBe(text)
    })
  }
})

describe('with a saved copy (settings.json.bak)', () => {
  it('a damaged file falls back to the last saved settings, keeps the damaged bytes and writes the good file back', async () => {
    const d = dir()
    const file = path.join(d, 'settings.json')
    const first = await createSettingsStore(file, fakeLog())
    await first.patch(GOOD)
    await first.flush()
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')).chat.pageSize).toBe(150)
    // A hand edit with a trailing comma.
    fs.writeFileSync(file, '{ "chat": { "pageSize": 120 }, }')
    const s = await createSettingsStore(file, fakeLog())
    expect(s.recovery?.kind).toBe('restored')
    expect(s.get().wizard.completed).toBe(true)
    expect(s.get().chat.pageSize).toBe(150)
    expect(fs.readFileSync(path.join(d, s.recovery!.copy!), 'utf8')).toBe('{ "chat": { "pageSize": 120 }, }')
    await s.flush()
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).chat.pageSize).toBe(150)
    // The next start reads a good file: nothing to report.
    expect((await createSettingsStore(file, fakeLog())).recovery).toBeNull()
  })

  it('writes are fsynced temp files renamed into place; no temp file is left', async () => {
    const d = dir()
    const s = await createSettingsStore(path.join(d, 'settings.json'), fakeLog())
    await s.patch({ chat: { pageSize: 60 } })
    expect(fs.readdirSync(d).sort()).toEqual(['settings.json', 'settings.json.bak'])
  })
})

describe('repairs and copies', () => {
  it('invalid values: repaired leaf by leaf, the original kept with a timestamp, reported with the dropped paths', async () => {
    const d = dir()
    const file = path.join(d, 'settings.json')
    const text = JSON.stringify({ wizard: { completed: true }, chat: { pageSize: 99999 } })
    fs.writeFileSync(file, text)
    const s = await createSettingsStore(file, fakeLog())
    expect(s.get().wizard.completed).toBe(true)
    expect(s.recovery).toMatchObject({ kind: 'repaired', dropped: ['chat.pageSize'] })
    expect(fs.readFileSync(path.join(d, s.recovery!.copy!), 'utf8')).toBe(text)
  })

  it('a repair is written back: the next start reads a clean file and reports nothing (told once, not every launch)', async () => {
    const d = dir()
    const file = path.join(d, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ wizard: { completed: true }, chat: { pageSize: 99999 } }))
    const s = await createSettingsStore(file, fakeLog(), { now: () => new Date(2026, 9, 5, 9, 0, 0).getTime() })
    expect(s.recovery?.kind).toBe('repaired')
    await s.flush()
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { wizard: { completed: boolean }; chat: { pageSize: number } }
    expect(saved.wizard.completed).toBe(true)
    expect(saved.chat.pageSize).toBe(s.get().chat.pageSize)
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))).toEqual(saved)
    // Next launch (a new atUtc would have been a new notice key): nothing to report.
    const next = await createSettingsStore(file, fakeLog(), { now: () => new Date(2026, 9, 6, 9, 0, 0).getTime() })
    expect(next.recovery).toBeNull()
    expect(badCopies(d)).toHaveLength(1)
  })

  it('a file that stays damaged across starts is copied once; at most 5 copies are kept', async () => {
    const d = dir()
    const file = path.join(d, 'settings.json')
    fs.writeFileSync(file, '{')
    let t = new Date(2026, 0, 1, 10, 0, 0).getTime()
    await createSettingsStore(file, fakeLog(), { now: () => t })
    t += 1000
    await createSettingsStore(file, fakeLog(), { now: () => t })
    expect(badCopies(d)).toHaveLength(1)
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(file, `{ broken ${i}`)
      t += 1000
      await createSettingsStore(file, fakeLog(), { now: () => t })
    }
    expect(badCopies(d)).toHaveLength(KEEP_BAD_COPIES)
  })
})

describe('the owner is told', () => {
  it('Bootstrap.health.settingsRecovered names the kept copy; the notice offers Set up again and Open folder', async () => {
    const t = await startTestServer({
      platform: (p) => {
        fs.mkdirSync(p.dataDir, { recursive: true })
        fs.writeFileSync(path.join(p.dataDir, 'settings.json'), '{ "wizard": { "completed": true }, }')
        return p
      }
    })
    try {
      const cookie = await t.login('desktop')
      const boot = (await t.inject({ url: '/api/bootstrap', cookie })).json() as { health: { settingsRecovered: { kind: string; copy: string } | null; lowDisk: unknown; lastBackupError: unknown } }
      expect(boot.health.settingsRecovered).toMatchObject({ kind: 'reset', copy: expect.stringMatching(/^settings\.json\.bad-\d{8}-\d{6}$/) })
      expect(boot.health.lowDisk).toBeNull()
      expect(boot.health.lastBackupError).toBeNull()
      const [n] = healthNotices(boot.health as never)
      expect(n).toMatchObject({ kind: 'settings', tone: 'danger', setup: true, folder: true, title: "Your settings couldn't be read" })
      expect(n.text).toContain(boot.health.settingsRecovered!.copy)
      // fix5-ui P07: the toast's line is short — the kept file's name is on the Settings banner only.
      expect(n.brief).not.toContain('settings.json')
      expect(n.brief.length).toBeLessThan(110)
    } finally {
      await t.close()
    }
  })
})

describe('one notice, not two (fix5-ui P07)', () => {
  it('Settings pages show the banners, so no toast is shown there', async () => {
    const { onSettingsPage } = await import('../../../src/web/features/health/health.logic')
    expect(onSettingsPage('/settings')).toBe(true)
    expect(onSettingsPage('/settings/data')).toBe(true)
    expect(onSettingsPage('/s/abc')).toBe(false)
    expect(onSettingsPage('/settingsx')).toBe(false)
    expect(onSettingsPage('/setup')).toBe(false)
  })
})
