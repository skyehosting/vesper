/**
 * A small live resource: one REST load shared by every component that shows it, kept fresh by WebSocket events while
 * at least one component is mounted (ref-counted acquire/release, so leaving the page releases the listeners — the
 * owner asked for leak testing; `liveStats()` counts them for the e2e leak check).
 *
 *   const prompts = createLive({ load: () => api('GET /api/prompts'), refetchOn: ['prompts.changed'] })
 *   const { data, error, loading, reload } = useLive(prompts)
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ServerMsgType } from '@shared/ws'
import type { ApiError } from '@shared/errors'
import { toApiError } from '../../lib/errors.logic'
import { ws, type MsgOf } from '../../lib/ws'

export interface LiveState<T> {
  data: T | null
  error: ApiError | null
  loading: boolean
}

export interface Live<T> {
  get(): LiveState<T>
  subscribe(cb: () => void): () => void
  acquire(): void
  release(): void
  reload(): Promise<void>
  /** Replace the value locally (optimistic updates, event payloads). */
  set(data: T): void
  readonly name: string
}

interface Options<T> {
  name: string
  load: () => Promise<T>
  /** Events that mean "fetch again" (coalesced while a load is running). */
  refetchOn?: ServerMsgType[]
  /** Events that carry the new value. */
  apply?: { [K in ServerMsgType]?: (msg: MsgOf<K>, current: T | null) => T | null }
  initial?: () => T | null
}

let activeListeners = 0
let activeResources = 0

/** Live WS listeners and acquired resources across all live stores (both return to 0 when no page is open). */
export function liveStats(): { listeners: number; resources: number } {
  return { listeners: activeListeners, resources: activeResources }
}

export function createLive<T>(o: Options<T>): Live<T> {
  let state: LiveState<T> = { data: o.initial?.() ?? null, error: null, loading: false }
  const subs = new Set<() => void>()
  let refs = 0
  let offs: (() => void)[] = []
  let inflight: Promise<void> | null = null
  let again = false
  let gen = 0

  const emit = (next: Partial<LiveState<T>>): void => {
    state = { ...state, ...next }
    for (const cb of [...subs]) cb()
  }

  const reload = (): Promise<void> => {
    if (inflight) {
      again = true
      return inflight
    }
    const my = ++gen
    emit({ loading: true })
    inflight = o
      .load()
      .then(
        (data) => {
          if (my === gen) emit({ data, error: null, loading: false })
        },
        (e: unknown) => {
          if (my === gen) emit({ error: toApiError(e), loading: false })
        }
      )
      .finally(() => {
        inflight = null
        if (again && refs > 0) {
          again = false
          void reload()
        }
      })
    return inflight
  }

  const on = <K extends ServerMsgType>(type: K, cb: (m: MsgOf<K>) => void): void => {
    const off = ws.on(type, cb)
    activeListeners++
    offs.push(() => {
      off()
      activeListeners--
    })
  }

  return {
    name: o.name,
    get: () => state,
    subscribe(cb) {
      subs.add(cb)
      return () => void subs.delete(cb)
    },
    acquire() {
      if (refs++ > 0) return
      activeResources++
      for (const t of o.refetchOn ?? []) on(t, () => void reload())
      for (const [t, fn] of Object.entries(o.apply ?? {}) as [ServerMsgType, (m: never, c: T | null) => T | null][]) {
        on(t, (m) => {
          const next = fn(m as never, state.data)
          if (next !== null) emit({ data: next, error: null })
        })
      }
      // Reconnected after a gap: events may have been missed.
      const offStatus = ws.onStatus((info) => {
        if (info.status === 'ready' && state.data !== null) void reload()
      })
      activeListeners++
      offs.push(() => {
        offStatus()
        activeListeners--
      })
      void reload()
    },
    release() {
      if (refs === 0 || --refs > 0) return
      activeResources--
      for (const off of offs) off()
      offs = []
      again = false
    },
    reload,
    set: (data) => emit({ data, error: null })
  }
}

/** Subscribe a component to a live resource for its lifetime. */
export function useLive<T>(live: Live<T>): LiveState<T> & { reload: () => Promise<void> } {
  useEffect(() => {
    live.acquire()
    return () => live.release()
  }, [live])
  const st = useSyncExternalStore(live.subscribe, live.get, live.get)
  return { ...st, reload: live.reload }
}
