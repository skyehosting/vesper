/**
 * window.__vesperTest — the web client's test hooks (test builds + VESPER_TEST=1 only, 07 B10). Feature agents add
 * namespaces with registerTestHooks(ns, obj); specs call them through `hook('ns.fn', ...args)`.
 *
 * The app's CSP forbids string eval, so specs never use page.waitForFunction('…'): only function predicates and these
 * helpers (05 §5).
 */
import type { Page } from '@playwright/test'

export interface VesperTestHooks {
  ready(): boolean
  route(): string
  go(path: string): void
  errors: string[]
  ws: { connected(): boolean }
  [namespace: string]: unknown
}

declare global {
  interface Window {
    __vesperTest?: VesperTestHooks
  }
}

export type HookFn = <T = unknown>(dotted: string, ...args: unknown[]) => Promise<T>

/** Call `window.__vesperTest.<dotted>(...args)` (awaited in the page). */
export function hookCaller(page: Page): HookFn {
  return async <T>(dotted: string, ...args: unknown[]): Promise<T> =>
    (await page.evaluate(
      async ({ p, a }) => {
        const parts = p.split('.')
        let owner: unknown = window.__vesperTest
        for (const part of parts.slice(0, -1)) owner = (owner as Record<string, unknown> | undefined)?.[part]
        const fn = (owner as Record<string, unknown> | undefined)?.[parts[parts.length - 1]]
        if (typeof fn !== 'function') throw new Error(`No test hook: __vesperTest.${p}`)
        return (await (fn as (...x: unknown[]) => unknown).apply(owner, a)) as unknown
      },
      { p: dotted, a: args }
    )) as T
}

/** Poll a hook until it returns something truthy (exceptions count as "not yet"). */
export async function waitForHook(page: Page, hook: HookFn, dotted: string, o: { timeout?: number; args?: unknown[] } = {}): Promise<void> {
  const deadline = Date.now() + (o.timeout ?? 30_000)
  let last: unknown = null
  for (;;) {
    try {
      if (await hook(dotted, ...(o.args ?? []))) return
    } catch (e) {
      last = e
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for __vesperTest.${dotted}()${last ? ` (last error: ${String(last)})` : ''}`)
    await page.waitForTimeout(100)
  }
}

/**
 * Wait until the client registered its hooks and has reported ready continuously for READY_STABLE_MS. A single true
 * reading is not enough: a page that just committed asks for new font faces a frame later (document.fonts goes back to
 * 'loading'), and a redirect may still be on its way.
 */
export const READY_STABLE_MS = 150

export async function waitForReady(page: Page, timeout = 30_000): Promise<void> {
  try {
    await page.waitForFunction(
      (stableMs) => {
        const w = window as unknown as { __vesperTest?: { ready?: () => boolean }; __vesperReadySince?: number }
        const ok = typeof w.__vesperTest?.ready === 'function' && w.__vesperTest.ready() === true
        if (!ok) {
          w.__vesperReadySince = 0
          return false
        }
        w.__vesperReadySince ||= performance.now()
        return performance.now() - w.__vesperReadySince >= stableMs
      },
      READY_STABLE_MS,
      { timeout, polling: 25 }
    )
  } catch (e) {
    const why = await page.evaluate(() => (typeof window.__vesperTest?.notReady === 'function' ? window.__vesperTest.notReady() : 'no hooks')).catch(() => 'page gone')
    throw new Error(`waitForReady: not ready after ${timeout} ms (${why})`, { cause: e })
  }
}

/** Errors the client collected itself (window.__vesperTest.errors). */
export async function clientErrors(page: Page): Promise<string[]> {
  return page.evaluate(() => (Array.isArray(window.__vesperTest?.errors) ? [...window.__vesperTest.errors] : []))
}

/** Console messages that are not app errors. */
export const ALLOWED_CONSOLE_ERRORS: RegExp[] = [/Download the React DevTools/i]

export function collectPageErrors(page: Page, into: string[]): void {
  page.on('console', (m) => {
    if (m.type() === 'error' && !ALLOWED_CONSOLE_ERRORS.some((r) => r.test(m.text()))) into.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => into.push(`pageerror: ${e.message}`))
}
