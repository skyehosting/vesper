/**
 * F38 (R9, R13/A3, 07 C13): every memory function documented to text-mode models is a control tag — hidden, never
 * spoken or stored, and run by the engine. The list is derived from MEMORY_FUNCTIONS so the two cannot drift.
 */
import { describe, expect, it } from 'vitest'
import { MEMORY_FUNCTIONS } from '@shared/memoryFunctions'
import { CONTROL_TAGS, parseControlTag, stripControlTags } from '@shared/tags'

describe('memory functions are control tags (F38)', () => {
  it('CONTROL_TAGS = tone + every memory function', () => {
    expect([...CONTROL_TAGS].sort()).toEqual(['tone', ...MEMORY_FUNCTIONS.map((f) => f.name)].sort())
  })

  it.each(MEMORY_FUNCTIONS.map((f) => [f.name, f.example] as const))('%s: its documented example parses and is removed from the visible text', (name, example) => {
    expect(parseControlTag(example)?.name).toBe(name)
    const r = stripControlTags(`Let me look.\n${example}`)
    expect(r.text).toBe('Let me look.\n')
    expect(r.tags.map((t) => t.name)).toEqual([name])
  })

  it('memory_sessions with no arguments is still a call', () => {
    expect(parseControlTag('[memory_sessions]')?.name).toBe('memory_sessions')
    expect(parseControlTag('[Memory_Sessions: recipes]')).toMatchObject({ name: 'memory_sessions', attrs: { query: 'recipes' } })
  })
})
