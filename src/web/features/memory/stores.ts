/**
 * The memory feature's live resources (live.ts): memory status (`memory.progress`), the sessions manifest and pinned
 * facts. Module singletons, so the settings page, the viewer and the commands share one copy.
 */
import type { Endpoints } from '@shared/api'
import type { Fact, MemoryStatus } from '@shared/types/domain'
import { api } from '../../lib/api'
import { useStore } from '../../lib/store'
import { createLive } from './live'

export const memoryStatus = createLive<MemoryStatus>({
  name: 'memoryStatus',
  load: () => api('GET /api/memory/status'),
  apply: { 'memory.progress': (m) => m.status },
  initial: () => useStore.getState().bootstrap?.memory ?? null
})

export type Manifest = Endpoints['GET /api/memory/manifest']['res']

export const manifest = createLive<Manifest>({
  name: 'manifest',
  load: () => api('GET /api/memory/manifest'),
  refetchOn: ['sessions.changed', 'session.updated', 'session.deleted', 'session.ended']
})

export const facts = createLive<Fact[]>({
  name: 'facts',
  load: () => api('GET /api/facts')
})
