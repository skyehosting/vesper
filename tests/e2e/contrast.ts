/**
 * Measured legibility over the chat backdrop (v1.1, 07 H-v11-presence): for every text run in the chat body (message
 * text, the metadata row, separators, the greeting), the AVATAR LAYER alone behind its box — everything in the chat
 * body hidden but the backdrop, so bubbles and row backgrounds never mask what the avatar does (conservative) — over
 * several frames (the avatar moves), and the worst WCAG ratio per text token: the brightest capped pixel in the dark
 * theme, the darkest in the light one.
 */
import { createRequire } from 'node:module'
import type { Page } from '@playwright/test'

interface PNG {
  width: number
  height: number
  data: Buffer
}
// pngjs ships without types (a transitive dependency); only the sync reader is used.
const { PNG } = createRequire(__filename)('pngjs') as { PNG: { sync: { read(b: Buffer): PNG } } }

interface Run {
  x: number
  y: number
  w: number
  h: number
  color: [number, number, number]
  token: string
  where: string
}

export interface ContrastResult {
  /** Worst ratio per text token (body text is --text-0 / --text-1, meta --text-2). */
  byToken: Record<string, { ratio: number; where: string; bg: [number, number, number] }>
  /** The same runs with the backdrop hidden (the page alone). */
  baseline: Record<string, number>
  runs: number
}

const lin = (c: number): number => {
  const v = c / 255
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
}
const lum = (r: number, g: number, b: number): number => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

async function textRuns(page: Page): Promise<Run[]> {
  return page.evaluate(() => {
    const body = document.querySelector('.chat__body')
    if (!body) return []
    const bodyRect = body.getBoundingClientRect()
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const out: Array<{ x: number; y: number; w: number; h: number; color: [number, number, number]; token: string; where: string }> = []
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n && out.length < 1500; n = walker.nextNode()) {
      const el = n.parentElement
      if (!el || !n.textContent?.trim()) continue
      if (el.closest('.chat-backdrop, .sr-only')) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/.exec(cs.color)
      if (!m || (m[4] !== undefined && Number(m[4]) < 0.05)) continue
      let token = cs.color
      for (const t of ['--text-0', '--text-1', '--text-2', '--accent-ink', '--accent']) {
        probe.style.color = cs.getPropertyValue(t).trim()
        el.appendChild(probe)
        if (getComputedStyle(probe).color === cs.color) token = t
        probe.remove()
      }
      const range = document.createRange()
      range.selectNodeContents(n)
      const where = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0] || ''}`
      for (const r of Array.from(range.getClientRects())) {
        const x0 = Math.max(r.left, bodyRect.left)
        const y0 = Math.max(r.top, bodyRect.top)
        const x1 = Math.min(r.right, bodyRect.right, window.innerWidth)
        const y1 = Math.min(r.bottom, bodyRect.bottom, window.innerHeight)
        if (x1 - x0 < 2 || y1 - y0 < 4) continue
        out.push({ x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0), color: [Number(m[1]), Number(m[2]), Number(m[3])], token, where })
      }
    }
    return out
  })
}

/** Everything in the chat body but the avatar layer (the page background stays). */
const AVATAR_ONLY = `.chat__body > *:not(.chat-backdrop) { visibility: hidden !important; }`

async function backgroundShot(page: Page, extraCss = ''): Promise<PNG> {
  const handle = await page.addStyleTag({ content: AVATAR_ONLY + extraCss })
  await page.waitForTimeout(30)
  const buf = await page.screenshot({ animations: 'allow' })
  await handle.evaluate((el) => (el as Element).remove())
  return PNG.sync.read(buf)
}

function worst(runs: Run[], pngs: PNG[], scale: number): ContrastResult['byToken'] {
  const out: ContrastResult['byToken'] = {}
  for (const run of runs) {
    const tl = lum(...run.color)
    for (const png of pngs) {
      const W = png.width
      for (let y = Math.round(run.y * scale); y < Math.round((run.y + run.h) * scale) && y < png.height; y++) {
        for (let x = Math.round(run.x * scale); x < Math.round((run.x + run.w) * scale) && x < W; x++) {
          const i = (y * W + x) * 4
          const bg: [number, number, number] = [png.data[i], png.data[i + 1], png.data[i + 2]]
          const c = Math.round(ratio(tl, lum(...bg)) * 100) / 100
          const cur = out[run.token]
          if (!cur || c < cur.ratio) out[run.token] = { ratio: c, where: run.where, bg }
        }
      }
    }
  }
  return out
}

/** Worst contrast per token over `frames` captures `gapMs` apart. */
export async function measureContrast(page: Page, frames = 4, gapMs = 200): Promise<ContrastResult> {
  const runs = await textRuns(page)
  const scale = await page.evaluate(() => window.devicePixelRatio || 1)
  const pngs: PNG[] = []
  for (let i = 0; i < frames; i++) {
    pngs.push(await backgroundShot(page))
    if (gapMs) await page.waitForTimeout(gapMs)
  }
  const base = await backgroundShot(page, ' .chat-backdrop { visibility: hidden !important; }')
  const baseline: Record<string, number> = {}
  for (const [k, v] of Object.entries(worst(runs, [base], scale))) baseline[k] = v.ratio
  return { byToken: worst(runs, pngs, scale), baseline, runs: runs.length }
}
