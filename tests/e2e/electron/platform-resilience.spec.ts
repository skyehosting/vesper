/**
 * fix-platform (phase 4c) in the desktop app — F60: a damaged vesper.db no longer just refuses to start. The start-up
 * check finds it, the native dialog (answered by VESPER_DIALOG_ANSWER in tests, printed as VESPER_DIALOG) offers
 * "Restore the backup from <date>" / "Start fresh (keep the damaged file)" / "Quit"; Restore brings back the backup's
 * chats and keeps the damaged file in backups/damaged-*.
 * F21 — a reply that finishes while the window is not focused shows a notification (printed as VESPER_NOTIFY in tests)
 * without message text unless previews are on; the tray shows a red dot while a device streams mic audio. @R20 @R21
 */
import { expect, test } from '@playwright/test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startMockServer, type MockServer } from '../../mocks/server'
import { configureMockLlm, createSession, wsTurn } from '../helpers'
import { launchApp, removeDirs, type TestApp } from '../launch'

let t: TestApp | null = null

test.afterEach(async () => {
  await t?.close()
  t = null
})

test('F60: a damaged database → restore dialog → the backup’s chats are back, the damaged file kept @R20', async () => {
  t = await launchApp()
  await t.waitHook('ws.connected')
  expect((await t.api('POST', '/api/sessions', { title: 'Kept by the backup' })).status).toBe(200)
  const backup = await t.api<{ file: string }>('POST', '/api/backup')
  expect(backup.status).toBe(200)
  const { dataDir, localDir } = t
  await t.close({ keepData: true })
  t = null
  try {
    const dbFile = path.join(dataDir, 'vesper.db')
    for (const f of ['-wal', '-shm']) fs.rmSync(`${dbFile}${f}`, { force: true })
    const junk = crypto.randomBytes(64 * 1024)
    fs.writeFileSync(dbFile, junk)

    t = await launchApp({ dataDir, localDir, env: { VESPER_DIALOG_ANSWER: '0' } })
    await t.waitHook('ws.connected')
    const sessions = await t.api<{ items: { title: string }[] }>('GET', '/api/sessions')
    expect(sessions.json.items.map((s) => s.title)).toEqual(['Kept by the backup'])
    const damaged = fs.readdirSync(path.join(dataDir, 'backups')).filter((n) => n.startsWith('damaged-'))
    expect(damaged).toHaveLength(1)
    expect(fs.readFileSync(path.join(dataDir, 'backups', damaged[0], 'vesper.db')).equals(junk)).toBe(true)
    await t.assertNoErrors()
  } finally {
    await t?.close()
    t = null
    removeDirs([dataDir, localDir])
  }
})

test('F21: reply notifications without text by default, with text when previews are on; the tray mic dot @R21', async () => {
  const mock: MockServer = await startMockServer()
  try {
    t = await launchApp({ mock, env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: 'fake words' } })
    const out: string[] = []
    t.app.process().stdout?.on('data', (b: Buffer) => out.push(String(b)))
    const notes = () =>
      out
        .join('')
        .split('\n')
        .filter((l) => l.startsWith('VESPER_NOTIFY '))
        .map((l) => JSON.parse(l.slice('VESPER_NOTIFY '.length)) as { title: string; body: string })
    await t.waitHook('ws.connected')
    await configureMockLlm(t.api, mock.url)
    const s = await createSession(t.api, 'Shopping list')
    // The window goes to the background. Test runs keep renderers "visible" (backgrounding is switched off for
    // deterministic rendering), so the page reports what a hidden, unfocused window reports.
    await t.page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.hasFocus = () => false
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('blur'))
    })
    expect((await wsTurn(t.page, s.uid, 'milk')).body).toBe('Echo: milk')
    await expect.poll(notes).toEqual([{ title: 'Vesper', body: 'A reply is ready.' }])
    expect((await t.api('PATCH', '/api/settings', { chat: { notificationPreviews: true } })).status).toBe(200)
    await wsTurn(t.page, s.uid, 'eggs')
    await expect.poll(() => notes()[1]).toEqual({ title: 'Shopping list', body: 'Echo: eggs' })

    // A device streams mic audio: red dot + its name in the tooltip; gone when it stops.
    const trayMic = () => t!.app.evaluate(() => (globalThis as unknown as { __vesperTrayMic: () => { dot: boolean; tooltip: string } }).__vesperTrayMic())
    expect(await trayMic()).toEqual({ dot: false, tooltip: 'Vesper' })
    await t.page.evaluate(() => {
      const w = window as unknown as { __mic: WebSocket }
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host}/ws`)
        w.__mic = ws
        ws.onerror = () => reject(new Error('ws error'))
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, tz: 'UTC', tzOffset: 0, client: { visible: true, focused: false, audioUnlocked: false }, deviceName: 'e2e-mic' }))
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data)) as { t: string; id?: string }
          if (m.t === 'ready') ws.send(JSON.stringify({ t: 'stt.start', id: 'mic-dot', sessionUid: null, mode: 'dictate', sampleRate: 16000, ttsActive: false }))
          if (m.t === 'ack' && m.id === 'mic-dot') resolve()
        }
      })
    })
    await expect.poll(trayMic).toMatchObject({ dot: true, tooltip: expect.stringMatching(/^Vesper — microphone in use: /) })
    await t.page.evaluate(() => (window as unknown as { __mic: WebSocket }).__mic.close())
    await expect.poll(trayMic).toEqual({ dot: false, tooltip: 'Vesper' })
    await t.assertNoErrors()
  } finally {
    await t?.close()
    t = null
    await mock.close()
  }
})
