/**
 * Voice input in the desktop app @R19: the STT process runs as an Electron utilityProcess (07 C17, spike S1) with the
 * real bundled Silero VAD; a speech fixture streamed from the window's page over its WebSocket comes back as
 * stt.final, and "Unload voice models now" ends the process.
 */
import { expect, test } from '@playwright/test'
import { launchApp, type TestApp } from '../launch'
import { fixturePcm, wsDictation } from '../stt'

let t: TestApp | null = null

test.afterEach(async () => {
  await t?.close()
  t = null
})

test('dictation through the utility process, then unload @R19', async () => {
  t = await launchApp({ env: { VESPER_STT_FAKE: '1', VESPER_STT_FAKE_TEXT: 'spoken in the desktop app' } })
  await t.waitHook('ws.connected')
  const r = await wsDictation(t.page, fixturePcm('hello'), { mode: 'dictate' })
  expect(r.final).toMatchObject({ text: 'spoken in the desktop app', autoSend: false })
  expect(r.states).toContain('transcribing')
  expect((await t.api('POST', '/api/stt/unload')).status).toBe(204)
  await t.assertNoErrors()
})
