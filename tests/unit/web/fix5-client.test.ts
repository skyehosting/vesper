/**
 * Phase 5b fix5-client regressions (docs/review/phase5a-findings.md).
 */
import { describe, expect, it, vi } from 'vitest'
import type { Bootstrap } from '@shared/api'
import { defaultSettings } from '@shared/settings'

const handlers = new Map<string, (m: unknown) => void>()
vi.mock('../../../src/web/lib/ws', () => ({
  ws: {
    on: (t: string, fn: (m: unknown) => void) => {
      handlers.set(t, fn)
      return () => handlers.delete(t)
    },
    onStatus: () => () => undefined
  }
}))
vi.mock('../../../src/web/lib/api', () => ({ api: () => Promise.reject(new Error('no api in unit tests')) }))
vi.mock('../../../src/web/features/sessions/cache', () => ({ invalidatePrompts: () => undefined, primeVoices: () => undefined }))

// Browser-side modules (outside the node typecheck project): imported by a computed path, typed by hand.
interface StoreState {
  bootstrap: Bootstrap | null
  settings: Bootstrap['settings'] | null
  ui: { memoryStatus: Bootstrap['memory'] | null; gameMode: { active: boolean; reason: string } }
  setBootstrap(b: Bootstrap): void
  applySettings(s: Bootstrap['settings']): void
  markSecret(name: string, saved: boolean): void
  setSecrets(set: string[], invalid: string[]): void
}
interface Store {
  getState(): StoreState
  setState(fn: (s: StoreState) => Partial<StoreState>): void
}
const STORE = '../../../src/web/lib/store/index.ts'
const LIVE = '../../../src/web/features/sessions/live.ts'
const { useStore } = (await import(/* @vite-ignore */ STORE)) as { useStore: Store }
const { installLive } = (await import(/* @vite-ignore */ LIVE)) as { installLive: () => void }

function fetchedBootstrap(memory: Bootstrap['memory']['state'], game = false): Bootstrap {
  // A bootstrap as the server sends it: parsed from JSON, so every nested object is new.
  return JSON.parse(
    JSON.stringify({
      version: '1',
      desktop: true,
      device: { id: 'd', kind: 'desktop', name: 'PC', listener: 'A', sudo: true },
      settings: defaultSettings(),
      secretsSet: [],
      secretsInvalid: [],
      network: {},
      memory: { state: memory, model: null, dim: null, indexed: 0, queued: 0, errors: 0, tier: 'unknown', queueEtaSec: null },
      portable: false,
      isTest: true,
      gameMode: { active: game, reason: game ? 'manual' : 'off' },
      dataPaths: null
    })
  ) as Bootstrap
}

describe('P01/P16 the memory chip and game mode keep their live state when the bootstrap copy changes', () => {
  it('settings, secret and health updates never re-seed the startup status; a new bootstrap does', () => {
    const st = useStore.getState
    st().setBootstrap(fetchedBootstrap('disabled'))
    installLive()
    expect(st().ui.memoryStatus?.state).toBe('disabled')
    // The wizard turns Voyage on: the server broadcasts progress, and game mode starts.
    handlers.get('memory.progress')!({ t: 'memory.progress', status: { ...st().bootstrap!.memory, state: 'ready' } })
    handlers.get('gamemode.changed')!({ t: 'gamemode.changed', active: true, reason: 'auto' })
    expect(st().ui.memoryStatus?.state).toBe('ready')
    // Local copies of the bootstrap: a settings answer, a saved secret (store + feature helpers), a health change.
    st().applySettings({ ...st().settings!, chat: { ...st().settings!.chat, fontSize: 17 } } as never)
    st().markSecret('tts:elevenlabs', true)
    st().setSecrets(['voyage'], [])
    st().setBootstrap({ ...st().bootstrap!, secretsSet: ['voyage', 'tts:elevenlabs'] })
    useStore.setState((s) => ({ bootstrap: { ...s.bootstrap!, health: {} as never } }))
    expect(st().ui.memoryStatus?.state).toBe('ready')
    expect(st().ui.gameMode).toEqual({ active: true, reason: 'auto' })
    // A genuinely new bootstrap (sign-in, reconnect after a restart) seeds again.
    st().setBootstrap(fetchedBootstrap('keyword-only', false))
    expect(st().ui.memoryStatus?.state).toBe('keyword-only')
    expect(st().ui.gameMode.active).toBe(false)
  })
})

describe('P08 inline math: $…$ (heuristic), \\( \\) and \\[ \\] render as math; prices stay text', async () => {
  const { normalizeMath, restoreDollars, hasMathSyntax, isDisplaySource } = await import('../../../src/web/features/chat/markdown/math.logic')
  const { fromMarkdown } = await import('mdast-util-from-markdown')
  const { mathFromMarkdown } = await import('mdast-util-math')
  const { math } = await import('micromark-extension-math')
  const { gfm } = await import('micromark-extension-gfm')
  const { gfmFromMarkdown } = await import('mdast-util-gfm')
  type N = { type: string; value?: string; children?: N[] }
  /** Formulas as the renderer parses the normalized text (single-dollar math on). */
  const formulas = (src: string): string[] => {
    const norm = normalizeMath(src)
    expect(norm.length).toBe(src.length)
    const tree = fromMarkdown(norm, { extensions: [gfm(), math({ singleDollarTextMath: true })], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] }) as N
    const out: string[] = []
    const walk = (n: N): void => {
      if (n.type === 'inlineMath' || n.type === 'math') out.push(n.value!.trim())
      for (const c of n.children ?? []) walk(c)
    }
    walk(tree)
    return out
  }
  it('typesets the forms models use', () => {
    expect(formulas('Inline too: $e^{i\\pi}+1=0$.')).toEqual(['e^{i\\pi}+1=0'])
    expect(formulas('the energy is \\( E = mc^2 \\) here')).toEqual(['E = mc^2'])
    expect(formulas('\\[ \\frac{a}{b} \\]')).toEqual(['\\frac{a}{b}'])
    expect(formulas('\\[\n\\int_0^1 x\\,dx\n\\]\n\nAfter.')).toEqual(['\\int_0^1 x\\,dx'])
    expect(formulas('where $x$ is the input and $\\alpha$ the rate')).toEqual(['x', '\\alpha'])
    expect(formulas('display $$a^2$$ as before')).toEqual(['a^2'])
    expect(formulas('$$\nx^2\n$$')).toEqual(['x^2'])
  })
  it('keeps prices and other dollars as text', () => {
    expect(formulas('It costs $5 and $10 with tax.')).toEqual([])
    expect(formulas('Between $5-$10, or $20,000 to $30,000.')).toEqual([])
    expect(formulas('Save $5 today, $x$ is fine')).toEqual(['x'])
    expect(formulas('A \\$5 note and \\(unclosed')).toEqual([])
    expect(restoreDollars(normalizeMath('It costs $5 and $10.'))).toBe('It costs $5 and $10.')
  })
  it('keeps escaped brackets and parentheses in prose as text (\\[1\\], \\[sic\\], \\(see above\\))', () => {
    expect(formulas('References \\[1\\] and \\[2\\] in escaped brackets.')).toEqual([])
    expect(formulas('He wrote "teh" \\[sic\\] twice.')).toEqual([])
    expect(formulas('As noted \\(see above\\), and \\[a, b\\] too.')).toEqual([])
    expect(normalizeMath('References \\[1\\] and \\[sic\\].')).toBe('References \\[1\\] and \\[sic\\].')
    // A formula still counts inline, and `\[` alone on its line opens a display block whatever it holds.
    expect(formulas('so \\[ x^2 + 1 \\] and \\(x\\) here')).toEqual(['x^2 + 1', 'x'])
    expect(formulas('\\[\n42\n\\]')).toEqual(['42'])
    expect(formulas('  \\[\n  \\text{area}\n  \\]')).toEqual(['\\text{area}'])
  })
  it('leaves code alone', () => {
    const src = '```sh\necho $HOME \\( x \\)\n```\n\nRun `echo $PATH` then $y^2$.'
    const norm = normalizeMath(src)
    const fenceEnd = src.indexOf('```\n\n') + 3
    expect(norm.slice(0, fenceEnd)).toBe(src.slice(0, fenceEnd))
    expect(norm).toContain('`echo $PATH`')
    expect(formulas(src)).toEqual(['y^2'])
  })
  it('knows a \\[ display formula and when a text needs KaTeX', () => {
    expect(isDisplaySource('a \\[x\\]', 2)).toBe(true)
    expect(isDisplaySource('a \\(x\\)', 2)).toBe(false)
    expect(hasMathSyntax('costs $5 and $6')).toBe(false)
    expect(hasMathSyntax('\\(x\\)')).toBe(true)
    expect(hasMathSyntax('$x^2$')).toBe(true)
  })
})


describe('P02 the Star keeps preparing the voice of a finished reply', async () => {
  const { deriveStarState, waitingVoices } = await import('../../../src/web/features/presence/state.logic')
  it('finished replies still waiting for their first audio count as preparing-voice; others are dropped', () => {
    const speech: Record<string, string> = { a: 'waiting', b: 'speaking', c: 'cancelled' }
    const left = waitingVoices(['a', 'b', 'c', 'gone'], (id) => speech[id])
    expect(left).toEqual(['a'])
    const base = { offline: false, speaking: false, stt: 'idle' as const, muted: false, errorAt: null, now: 0 }
    expect(deriveStarState({ ...base, replies: left.length ? ['preparing-voice'] : [] })).toBe('preparing-voice')
    expect(deriveStarState({ ...base, replies: [] })).toBe('idle')
  })
})
