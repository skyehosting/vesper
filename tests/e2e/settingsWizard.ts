/**
 * E2E helpers for Settings and the setup wizard (owner: settings-wizard): axe checks (07 D9: 0 serious/critical),
 * screenshots into PW_OUT, waiting for the instant-save queue, and the wizard's current step.
 */
import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import type { HookFn } from './hooks'
import { ROOT } from './launch'

export const SHOT_DIR = path.resolve(ROOT, process.env.PW_OUT ?? 'test-results/e2e', 'shots')

/** axe-core over the page (or a part of it): no serious or critical violations (07 D9). */
export async function expectNoAxeViolations(page: Page, label: string, include?: string): Promise<void> {
  // Entry animations blend colors mid-fade; axe measures contrast, so wait for finite animations to finish.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity))
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
  if (include) b = b.include(include)
  const r = await b.analyze()
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  const lines: string[] = []
  for (const v of bad) {
    lines.push(`${v.id} (${v.impact}): ${v.help}`)
    for (const n of v.nodes.slice(0, 4)) lines.push(`  ${n.target.join(' ')} ${JSON.stringify(n.any[0]?.data ?? '')}`)
  }
  expect(bad.length, `axe on ${label}:\n${lines.join('\n')}`).toBe(0)
}

export async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

/** Wait until every instant-save change is on the server. */
export async function settled(hook: HookFn, page: Page): Promise<void> {
  await expect.poll(() => hook<boolean>('settings.saveIdle'), { timeout: 10_000 }).toBe(true)
  await page.waitForTimeout(50)
}

export async function wizardStep(hook: HookFn): Promise<string | null> {
  return hook<string | null>('wizard.step')
}

export async function expectStep(hook: HookFn, id: string): Promise<void> {
  await expect.poll(() => wizardStep(hook), { timeout: 15_000 }).toBe(id)
}
