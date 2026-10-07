/**
 * Test hooks for sessions-ui (test builds in test mode only, 07 B10): `__vesperTest.nav.*` — leak counters, the
 * game-mode pill (driven without a real fullscreen game) and the list/panel state.
 */
import { kitStats } from '../../components/internal/stats'
import { openLayerCount } from '../../components/internal/layers'
import { registerTestHooks } from '../../lib/testHooks'
import { useStore } from '../../lib/store'
import type { GameModeReason } from '@shared/ws'
import { cacheStats } from './cache'
import { shortcutStats } from '../palette/shortcuts'

if (__VESPER_TEST__) {
  registerTestHooks('nav', {
    stats: () => ({ ...kitStats(), layers: openLayerCount(), ...prefix('shortcuts', shortcutStats()), ...prefix('cache', cacheStats()) }),
    setGameMode: (active: boolean, reason: GameModeReason = 'fullscreen') => useStore.getState().setGameMode({ active, reason }),
    ui: () => useStore.getState().ui,
    active: () => {
      const s = useStore.getState()
      return { uid: s.activeSessionUid, loaded: s.activeSession?.uid ?? null }
    },
    sidebarRows: () => document.querySelectorAll('.slist__row').length
  })
}

function prefix(p: string, o: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(o)) out[`${p}.${k}`] = v
  return out
}
