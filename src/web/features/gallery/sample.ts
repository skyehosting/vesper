/** Sample data for the gallery (fixed values so screenshots are stable). */
import type { RecalledItem } from '../../components/RememberedChip'

export const NOW = Date.UTC(2026, 9, 5, 18, 3)
const DAY = 86_400_000

export const VOICES = [
  { value: 'rachel', label: 'Rachel', description: 'American · calm narration', meta: 'Premade' },
  { value: 'adam', label: 'Adam', description: 'American · deep', meta: 'Premade' },
  { value: 'charlotte', label: 'Charlotte', description: 'Swedish accent · warm', meta: 'Premade', keywords: ['eleven_v3'] },
  { value: 'domi', label: 'Domi', description: 'Strong · multilingual', meta: 'Premade' },
  { value: 'aria', label: 'Aria', description: 'Expressive · social media', meta: 'Premade' },
  { value: 'emeraude', label: 'Émeraude', description: 'French · soft', meta: 'Cloned' },
  { value: 'old', label: 'Retired voice', description: 'No longer available', disabled: true },
  { value: 'zara', label: 'Zara', description: 'British · bright', meta: 'Premade' }
]

export const MODELS = [
  { value: 'claude-sonnet', label: 'Claude Sonnet', description: 'Vision · tools · 200k context' },
  { value: 'gpt-5-mini', label: 'GPT-5 mini', description: 'Vision · tools · 400k context' },
  { value: 'deepseek-chat', label: 'DeepSeek V3', description: 'Tools · 128k context' },
  { value: 'llama-local', label: 'Llama 3.3 (Ollama)', description: 'Runs on this PC' }
]

export const RECALLED: RecalledItem[] = [
  {
    id: 'r1',
    sessionUid: 's1',
    sessionShortId: 'K7Q2MX',
    sessionTitle: 'Trip to Kyoto',
    role: 'user',
    text: 'I want to see the moss garden at Saihō-ji, but it needs a postcard reservation months ahead.',
    tsUtc: NOW - 23 * DAY,
    tzName: 'America/New_York',
    tzOffsetMin: -240
  },
  {
    id: 'r2',
    sessionUid: 's1',
    sessionShortId: 'K7Q2MX',
    sessionTitle: 'Trip to Kyoto',
    role: 'assistant',
    text: 'Saihō-ji (Koke-dera) takes reservations by return postcard or its online form, usually two months in advance.',
    tsUtc: NOW - 23 * DAY + 60_000,
    tzName: 'America/New_York',
    tzOffsetMin: -240
  },
  {
    id: 'r3',
    sessionUid: 's2',
    sessionTitle: 'Morning journal',
    role: 'user',
    text: 'Slept badly again — the neighbours were moving furniture at 2 am.',
    tsUtc: NOW - 2 * DAY,
    tzName: 'America/New_York',
    tzOffsetMin: -240,
    sameSession: true
  }
]

export const TS_SAMPLE = `/** Debounce a function: run it once calls stop for \`ms\`. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms = 200) {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...args: A): void => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms) // last call wins
  }
}
`

export const PY_SAMPLE = `import asyncio

async def countdown(n: int) -> None:
    """Print n … 1, one per second."""
    while n > 0:
        print(f"{n}…")
        await asyncio.sleep(1)
        n -= 1

asyncio.run(countdown(3))
`

const WORDS = 'the quiet star listens while you think and answers when the evening settles into a slow and patient conversation about everything'.split(' ')

/** Deterministic pseudo-random rows of varying length for the virtual list. */
export function sampleRow(i: number): { id: number; who: 'user' | 'assistant'; text: string } {
  let x = (i * 2654435761) >>> 0
  const next = (): number => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
  const n = 4 + Math.floor(next() * (next() < 0.15 ? 120 : 30))
  const words: string[] = []
  for (let k = 0; k < n; k++) words.push(WORDS[Math.floor(next() * WORDS.length)])
  const text = words.join(' ')
  return { id: i, who: i % 2 === 0 ? 'user' : 'assistant', text: text[0].toUpperCase() + text.slice(1) + '.' }
}
