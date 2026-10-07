/**
 * platform-int in the desktop app: resource use comes from app.getAppMetrics() (private working sets per process
 * type, 07 D2), Bootstrap carries mute + game mode, no global hotkey is registered by default (opt-in, 07 D6), and the
 * main process forks utility processes with execArgv (the extract process runs; Electron throws on undefined).
 * Nothing here opens a folder or changes the system. @R14 @R19
 */
import { expect, test } from '@playwright/test'
import { launchApp, type TestApp } from '../launch'

let t: TestApp | null = null

test.afterEach(async () => {
  await t?.close()
  t = null
})

test('resource use from app metrics; bootstrap mute and game mode; hotkey off by default @R14 @R19', async () => {
  t = await launchApp()
  const r = await t.api<{ processes: { name: string; type: string; pid: number; memMB: number; privateMB: number | null }[]; totalMB: number }>('GET', '/api/system/resources')
  expect(r.status).toBe(200)
  const types = new Set(r.json.processes.map((p) => p.type))
  expect(types.has('Browser')).toBe(true)
  expect(types.has('Tab')).toBe(true)
  const main = r.json.processes.find((p) => p.type === 'Browser')!
  expect(main.name).toBe('Vesper (app + server)')
  expect(main.privateMB).toBeGreaterThan(10)
  expect(r.json.totalMB).toBeGreaterThan(main.memMB)

  const boot = await t.api<{ mute: boolean; gameMode: { active: boolean; reason: string }; settings: { voice: { globalHotkey: string | null } } }>('GET', '/api/bootstrap')
  expect(boot.json.mute).toBe(true)
  expect(boot.json.gameMode).toEqual({ active: false, reason: 'off' })
  expect(boot.json.settings.voice.globalHotkey).toBeNull()
  const registered = await t.app.evaluate(({ globalShortcut }) => ['Ctrl+Shift+Space', 'F13', 'CommandOrControl+Alt+Space'].some((a) => globalShortcut.isRegistered(a)))
  expect(registered).toBe(false)

  // A utility process forked with execArgv (the extract process: --max-old-space-size=512) works on the desktop.
  const att = await t.page.evaluate(async () => {
    const fd = new FormData()
    fd.append('file', new Blob(['execArgv reaches the utility process'], { type: 'text/plain' }), 'n.txt')
    const res = await fetch('/api/attachments', { method: 'POST', body: fd, headers: { 'x-vesper': '1' } })
    const ref = (await res.json()) as { sha: string; textState?: string }
    const text = ((await (await fetch(`/api/attachments/${ref.sha}/text`)).json()) as { text: string }).text
    return { state: ref.textState, text }
  })
  expect(att).toEqual({ state: 'ok', text: 'execArgv reaches the utility process' })
  await t.assertNoErrors()
})
