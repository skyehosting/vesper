/**
 * Live state the shell shows, kept current from realtime events (sessions-ui):
 *   - game mode (Bootstrap.gameMode, then `gamemode.changed`, 07 D3) → the "Game mode" pill;
 *   - memory status (Bootstrap.memory, then `memory.progress`) → the memory chip;
 *   - the updater (GET /api/system/update on every connect, then `update.state`, H-v12-updates) → Settings → About
 *     and the "Update ready" pill;
 *   - the open chat's full detail (GET /api/sessions/:uid), refetched when `session.updated`/`sessions.changed` say
 *     it changed (prompt, links and voice are not in the summary the event carries).
 *
 * `installLive()` wires the app-lifetime listeners once (like boot.ts's wiring); `useActiveSessionSync()` owns the
 * per-session fetch and is mounted by the shell.
 */
import { useEffect } from 'react'
import type { UpdateStatus } from '@shared/api'
import type { ServerMsg } from '@shared/ws'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { isFreshBootstrap } from '../../lib/store/settings.logic'
import { ws } from '../../lib/ws'
import { invalidatePrompts, primeVoices } from './cache'

let installed = false

export function installLive(): void {
  if (installed) return
  installed = true
  const st = useStore.getState
  ws.on('gamemode.changed', (m) => st().setGameMode({ active: m.active, reason: m.reason }))
  ws.on('memory.progress', (m) => st().setMemoryStatus(m.status))
  ws.on('prompts.changed', () => invalidatePrompts())
  ws.on('tts.voices', (m) => primeVoices(m.provider, m.voices, m.models))
  ws.on('update.state', (m) => st().setUpdate(updateOf(m)))
  ws.onStatus((info) => {
    if (info.status !== 'ready') return
    api('GET /api/system/update').then(
      (u) => st().setUpdate(u),
      () => undefined
    )
  })
  // Seed from the bootstrap only when the server sent a new one (sign-in, reconnect after a server restart). Local
  // copies of it (a settings answer, a saved secret, a health change) still carry the fetch-time status: re-seeding
  // from them put a stale "Keyword only" back over a live `memory.progress` (P01/P16).
  let seen: object | null = null
  const seed = (): void => {
    const b = st().bootstrap
    if (!b || !isFreshBootstrap(seen, b)) return
    seen = b.memory
    st().setGameMode(b.gameMode ?? { active: false, reason: 'off' })
    st().setMemoryStatus(b.memory)
  }
  seed()
  useStore.subscribe(seed)
}

/** The status part of an `update.state` event. */
function updateOf(m: Extract<ServerMsg, { t: 'update.state' }>): UpdateStatus {
  const { state, currentVersion, version, percent, releaseUrl, checkedUtc, error, portable } = m
  const s: UpdateStatus = { state, currentVersion, version, percent, releaseUrl, checkedUtc, error, portable }
  for (const k of Object.keys(s) as (keyof UpdateStatus)[]) if (s[k] === undefined) delete s[k]
  return s
}

/** How long a burst of `session.updated` events for the open chat is coalesced before refetching its detail. */
const REFRESH_DEBOUNCE_MS = 150

/** Keep `activeSession` loaded for `uid` (null = none open). */
export function useActiveSessionSync(uid: string | null): void {
  useEffect(() => {
    const st = useStore.getState
    st().setActiveSession(uid)
    if (!uid) return
    let ctrl: AbortController | null = null
    let timer: number | null = null
    const load = (): void => {
      ctrl?.abort()
      const c = new AbortController()
      ctrl = c
      api('GET /api/sessions/:uid', { params: { uid }, signal: c.signal })
        .then((s) => {
          if (!c.signal.aborted) st().setActiveSessionDetail(s)
        })
        .catch((e: unknown) => {
          if (c.signal.aborted) return
          // A deleted/unknown chat: the chat page shows its own error; the header falls back to the list row.
          if (st().activeSessionUid === uid) st().setActiveSessionError(toApiError(e))
        })
    }
    const schedule = (): void => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        load()
      }, REFRESH_DEBOUNCE_MS)
    }
    if (st().activeSession?.uid !== uid) load()
    const offs = [
      ws.on('session.updated', (m) => {
        if (m.sessionUid === uid) schedule()
      }),
      // Link changes on the *other* side (incoming links) arrive as list-wide changes.
      ws.on('sessions.changed', schedule),
      ws.on('epoch.created', (m) => {
        if (m.sessionUid === uid) schedule()
      }),
      ws.onStatus((info) => {
        if (info.status === 'ready') schedule()
      })
    ]
    return () => {
      ctrl?.abort()
      if (timer !== null) window.clearTimeout(timer)
      for (const off of offs) off()
    }
  }, [uid])
}
