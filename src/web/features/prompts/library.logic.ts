/** Prompt library helpers (pure). */
import type { Prompt } from '@shared/types/domain'

export const PROMPT_LIMITS = { name: 80, body: 100_000 } as const

/** Case-insensitive name match (names are unique on the server; NFC-normalized). */
export function findPrompt(list: readonly Prompt[], name: string): Prompt | undefined {
  const n = name.normalize('NFC').trim().toLowerCase()
  return list.find((p) => p.name.toLowerCase() === n)
}

/** Library entries matching a filter, by name then body. */
export function filterPrompts(list: readonly Prompt[], q: string): Prompt[] {
  const t = q.trim().toLowerCase()
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  if (!t) return sorted
  return sorted.filter((p) => p.name.toLowerCase().includes(t) || p.body.toLowerCase().includes(t))
}

/** A name not used yet: "Travel planner", "Travel planner (2)", … */
export function uniqueName(list: readonly Prompt[], base: string): string {
  const b = base.trim().slice(0, PROMPT_LIMITS.name - 4) || 'New prompt'
  if (!findPrompt(list, b)) return b
  for (let i = 2; i < 1000; i++) {
    const n = `${b} (${i})`
    if (!findPrompt(list, n)) return n
  }
  return `${b} ${Date.now()}`
}
