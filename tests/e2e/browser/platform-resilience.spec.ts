/**
 * fix-platform (phase 4c) over the built standalone server + headless Chromium:
 *   F59 — a damaged settings.json never re-runs the wizard silently: the desktop lands on Settings with a banner naming
 *         the kept copy (no toast there: Settings already shows it — fix5-ui P07); "Set up again" opens the wizard.
 * @R4 @R20
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchServer, removeDirs, type TestServer } from '../launch'

let s: TestServer | null = null
const dirs: string[] = []

test.afterEach(async () => {
  await s?.close()
  s = null
  removeDirs(dirs.splice(0))
})

function dataDirWith(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-e2e-res-'))
  dirs.push(d, `${d}-local`)
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text)
  return d
}

test('F59: a damaged settings.json opens Settings with a banner (once, no toast), not the wizard @R20', async () => {
  const dataDir = dataDirWith({ 'settings.json': '{ "wizard": { "completed": true }, "chat": { "pageSize": 150 }, }' })
  s = await launchServer({ login: 'desktop', dataDir, localDir: `${dataDir}-local` })
  await expect(s.page).toHaveURL(/\/settings/)
  const banner = s.page.locator('[data-health] .callout')
  await expect(banner).toContainText("Your settings couldn't be read")
  const copy = fs.readdirSync(dataDir).find((n) => n.startsWith('settings.json.bad-'))
  expect(copy).toBeTruthy()
  await expect(banner).toContainText(copy!)
  // fix5-ui P07: the notice is shown once — the banner — not repeated by a toast on the page it points to.
  await s.page.waitForTimeout(500)
  await expect(s.page.locator('.toast').filter({ hasText: "Your settings couldn't be read" })).toHaveCount(0)
  expect(fs.readFileSync(path.join(dataDir, copy!), 'utf8')).toContain('"pageSize": 150 }, }')
  await banner.getByRole('button', { name: 'Set up again' }).click()
  await expect(s.page).toHaveURL(/\/setup/)
  await s.assertNoErrors()
})

test('F66: low disk and a failed backup are shown on Settings → Data and as a toast @R20', async () => {
  // Every drive reports 100 MB free (VESPER_FAKE_FREE_BYTES); the backups folder can't be created (a file is in its way).
  const dataDir = dataDirWith({ backups: 'not a folder', 'settings.json': JSON.stringify({ wizard: { completed: true } }) })
  s = await launchServer({ login: 'desktop', dataDir, localDir: `${dataDir}-local`, env: { VESPER_FAKE_FREE_BYTES: String(100 * 1024 * 1024) } })
  await expect(s.page.getByText('Your disk is almost full').first()).toBeVisible()
  const backup = await s.api<{ error: { code: string } }>('POST', '/api/backup')
  expect(backup.status).toBeGreaterThanOrEqual(400)
  await s.page.goto(`${s.url}/settings/data`)
  await s.waitReady()
  const box = s.page.locator('[data-backup-health]')
  await expect(box).toContainText('Your disk is almost full')
  await expect(box).toContainText('Only 100 MB is free')
  await expect(box).toContainText('The last backup failed')
  await expect(s.page.locator('[data-health] .callout')).toHaveCount(2)
  if (process.env.SHOT) await s.page.screenshot({ path: process.env.SHOT })
  await s.assertNoErrors()
})
