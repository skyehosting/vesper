/**
 * Page side of code highlighting (07 D7): one lazily started worker, results cached in an LRU of 500 keyed by a hash
 * of (language, code), so re-rendered and re-mounted messages never highlight twice. The worker is terminated after
 * two idle minutes (pending requests are answered with null first); the next request starts it again.
 */
import { hashString, Lru } from '../internal/lru.logic'
import { track } from '../internal/stats'
import { normalizeLang } from './langs.logic'
import type { HlLines, HlRequest, HlResponse } from './protocol'

export type { HlLines, HlToken } from './protocol'

/** Larger blocks stay plain: tokenising them would cost more than it helps. */
export const MAX_HIGHLIGHT_CHARS = 100_000
const IDLE_MS = 120_000

const cache = new Lru<string, HlLines>(500)
const pending = new Map<number, (lines: HlLines | null) => void>()
let worker: Worker | null = null
let nextId = 1
let idleTimer: number | null = null
let failed = false

const keyOf = (lang: string, code: string): string => `${lang}:${code.length}:${hashString(code)}`

function stopIdleTimer(): void {
  if (idleTimer === null) return
  window.clearTimeout(idleTimer)
  idleTimer = null
  track('kit.timers', -1)
}

function armIdleTimer(): void {
  stopIdleTimer()
  track('kit.timers', 1)
  idleTimer = window.setTimeout(() => {
    idleTimer = null
    track('kit.timers', -1)
    if (pending.size === 0) disposeHighlighter()
  }, IDLE_MS)
}

function ensureWorker(): Worker | null {
  if (worker || failed) return worker
  try {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module', name: 'vesper-highlight' })
  } catch {
    failed = true
    return null
  }
  track('kit.workers', 1)
  worker.onmessage = (e: MessageEvent<HlResponse>) => {
    const done = pending.get(e.data.id)
    if (!done) return
    pending.delete(e.data.id)
    done(e.data.lines ?? null)
    if (pending.size === 0) armIdleTimer()
  }
  worker.onerror = () => {
    // A worker that can't load (CSP, missing chunk) means plain code from now on, not an error loop.
    failed = true
    disposeHighlighter()
  }
  return worker
}

/** Cached tokens for this block, if it was highlighted before (lets a remount paint highlighted immediately). */
export function cachedHighlight(code: string, langInfo: string | null | undefined): HlLines | undefined {
  const lang = normalizeLang(langInfo)
  return lang ? cache.get(keyOf(lang, code)) : undefined
}

/** Tokens for `code`, or null when the language is unknown/plain, the block is huge, or highlighting failed. */
export function highlight(code: string, langInfo: string | null | undefined): Promise<HlLines | null> {
  const lang = normalizeLang(langInfo)
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS || code.length === 0) return Promise.resolve(null)
  const key = keyOf(lang, code)
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  const w = ensureWorker()
  if (!w) return Promise.resolve(null)
  stopIdleTimer()
  const id = nextId++
  return new Promise<HlLines | null>((resolve) => {
    pending.set(id, (lines) => {
      if (lines) cache.set(key, lines)
      resolve(lines)
    })
    w.postMessage({ id, code, lang } satisfies HlRequest)
  })
}

/** Stop the worker now (tests, "Unload" in Settings → About). Pending requests resolve null. */
export function disposeHighlighter(): void {
  stopIdleTimer()
  for (const done of pending.values()) done(null)
  pending.clear()
  if (worker) {
    worker.terminate()
    worker = null
    track('kit.workers', -1)
  }
}

export function highlighterStats(): { worker: boolean; pending: number; cached: number } {
  return { worker: worker !== null, pending: pending.size, cached: cache.size }
}
