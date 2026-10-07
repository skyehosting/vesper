/**
 * Vesper 1.1 owner screenshot, phone (opt-in: V11_FINAL=1): a conversation at 390×844 while the AI speaks — Armilla
 * behind the messages in its 2D twin (phones draw no WebGL avatar, 07 D8) — and the contrast gate on the avatar layer.
 * The desktop shots are the Electron twin (electron/v11-final.shots.spec.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { startMockServer, type MockServer } from '../../mocks/server'
import { measureContrast } from '../contrast'
import { configureMockLlm, wsTurn } from '../helpers'
import { launchServer, type TestServer } from '../launch'

const OUT = process.env.V11_FINAL_OUT ?? 'C:\\Users\\Raven\\Desktop\\Vesper\\.scratch\\v11-final'

test.skip(!process.env.V11_FINAL, 'v1.1 owner screenshots: set V11_FINAL=1')

let mock: MockServer
let s: TestServer | null = null

test.beforeAll(async () => {
  mock = await startMockServer()
  fs.mkdirSync(OUT, { recursive: true })
})
test.afterEach(async () => {
  await s?.close()
  s = null
})
test.afterAll(async () => {
  await mock?.close()
})

test('v1.1 owner shot: phone 390×844, Armilla 2D behind a conversation', async () => {
  s = await launchServer({ mock })
  await s.waitHook('ws.connected')
  const desk = await s.login('desktop')
  await configureMockLlm(desk.api, mock.url)
  expect((await desk.api('PATCH', '/api/settings', { performance: { gameMode: 'off' }, appearance: { theme: 'dark', accent: 'gold' } })).status).toBe(200)
  await s.page.setViewportSize({ width: 390, height: 844 })
  const chat = (await desk.api<{ uid: string }>('POST', '/api/sessions', { title: 'Evening walk' })).json
  await s.hook('go', `/s/${chat.uid}`)
  await s.waitReady()
  mock.llm.script({ text: 'You went along the river path as far as the old mill, about four kilometres, and turned back when the light started going.' })
  await wsTurn(s.page, chat.uid, 'How far did I walk on Sunday?')
  mock.llm.script({ text: 'Try the loop past the mill and back through the orchard next weekend: about six kilometres, mostly flat. Leave around four so you are home before dark.' })
  await wsTurn(s.page, chat.uid, 'Could you suggest a longer route?')
  await s.page.waitForSelector('article.msg')
  await s.hook('presence.setFocus', true)
  await expect.poll(async () => (await s!.hook<{ armilla2d?: boolean }>('presence.surface')).armilla2d).toBe(true)
  await s.hook('presence.speak', 'Leave around four so you are home before dark, and take the thermos, the wind picks up along the water in the evening.')
  await s.page.waitForTimeout(1100)
  await s.page.screenshot({ path: path.join(OUT, 'phone-390x844.png') })
  const contrast = await measureContrast(s.page, 4, 180)
  await s.hook('audio.stop')
  fs.writeFileSync(path.join(OUT, 'contrast-phone.json'), JSON.stringify(contrast, null, 1))
  console.log(JSON.stringify(Object.fromEntries(Object.entries(contrast.byToken).map(([k, v]) => [k, v.ratio]))))
  // The gate (07 H-v11-presence): body text ≥ 7:1 in dark, text-1 / text-2 ≥ 4.5:1 — measured on the avatar layer.
  expect(contrast.byToken['--text-0']?.ratio ?? Infinity).toBeGreaterThanOrEqual(7)
  for (const tok of ['--text-1', '--text-2']) expect(contrast.byToken[tok]?.ratio ?? Infinity).toBeGreaterThanOrEqual(4.5)
  await s.assertNoErrors()
})
