/** Shared helpers for the speech tests: seeded PRNG, random markdown with hidden tags, mock alignment → timeline. */
import type { Timeline } from '@shared/revealMap'
import type { SynthResult } from '../../mocks/audio'

/** Deterministic PRNG so failures reproduce. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mock-provider alignment (per code point) → per-UTF-16-unit timeline over `text`. */
export function timelineOf(text: string, s: SynthResult, skip = 0): Timeline {
  const startsMs: number[] = []
  const endsMs: number[] = []
  let k = skip
  for (const cp of text) {
    for (let u = 0; u < cp.length; u++) {
      startsMs.push(s.alignment.character_start_times_seconds[k] * 1000)
      endsMs.push(s.alignment.character_end_times_seconds[k] * 1000)
    }
    k++
  }
  return { startsMs, endsMs }
}

const WORDS = ['hello', 'there', 'Vesper', 'remember', 'three', 'weeks', 'café', 'naïve', 'über', '42', '3.14', 'km', 'tomorrow', 'the', 'a', 'of', 'and', 'warm', 'happy']

export function randomMarkdown(r: () => number): string {
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]
  const sentence = () => {
    const n = 2 + Math.floor(r() * 12)
    const ws: string[] = []
    for (let i = 0; i < n; i++) {
      let w = pick(WORDS)
      const x = r()
      if (x < 0.08) w = `**${w}**`
      else if (x < 0.14) w = `*${w}*`
      else if (x < 0.18) w = `\`${w}\``
      else if (x < 0.21) w = `[${w}](https://example.com/${w})`
      else if (x < 0.23) w = 'https://bare.example.org/path'
      else if (x < 0.25) w = '🙂'
      else if (x < 0.29) w += ','
      ws.push(w)
    }
    return ws.join(' ') + pick(['.', '!', '?', '.', '…', ''])
  }
  const blocks: string[] = []
  const nb = 1 + Math.floor(r() * 6)
  for (let b = 0; b < nb; b++) {
    const x = r()
    if (x < 0.12) blocks.push(`${'#'.repeat(1 + Math.floor(r() * 3))} ${sentence()}`)
    else if (x < 0.25) blocks.push(Array.from({ length: 1 + Math.floor(r() * 4) }, () => `- ${sentence()}`).join('\n'))
    else if (x < 0.32) blocks.push('```js\nconst x = [1, 2]. // not spoken\n```')
    else if (x < 0.36) blocks.push('| a | b |\n|---|---|\n| 1 | 2 |')
    else if (x < 0.4) blocks.push('> ' + sentence())
    else blocks.push(Array.from({ length: 1 + Math.floor(r() * 4) }, sentence).join(' '))
  }
  let md = blocks.join('\n\n')
  // Hidden control tags at random places (07 A2: start by default, but anywhere is legal).
  const tags = Math.floor(r() * 3)
  const spots = Array.from({ length: tags }, () => (r() < 0.5 ? 0 : Math.floor(r() * md.length))).sort((a, b) => b - a)
  for (const at of spots) md = md.slice(0, at) + `[tone=${pick(['warm', 'gently teasing', 'calm, quiet'])}]` + md.slice(at)
  return md
}

export function randomSplits(s: string, r: () => number): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; ) {
    const n = 1 + Math.floor(r() * 9)
    out.push(s.slice(i, i + n))
    i += n
  }
  return out
}

