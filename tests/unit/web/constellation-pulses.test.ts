/**
 * Constellation recall pulses survive a map refresh (made deterministic for the e2e "pulses" step, Phase 4c): a
 * `session.updated` / `sessions.changed` during a reply reloads the map; a pulse still running stays on the same
 * session (by uid, the indices may move), a finished one goes. model.ts `setData` uses this.
 */
import { describe, expect, it } from 'vitest'
import { carryPulses } from '../../../src/web/features/presence/constellation/layout.logic'

describe('constellation pulses across a refresh', () => {
  it('a running pulse follows its session to its new index; finished ones and vanished sessions are dropped', () => {
    const before = ['a', 'b', 'c', 'gone']
    const byUid = new Map([['n', 0], ['a', 1], ['b', 2], ['c', 3]])
    const now = 10_000
    const pulses = new Map([[1, now - 100], [2, now - 3001], [3, now - 50]])
    const out = carryPulses(pulses, (i) => before[i], byUid, now, 3000)
    expect([...out.entries()]).toEqual([[2, now - 100]])
  })
})
