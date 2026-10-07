/**
 * Hooks shared by the voice settings pages and wizard steps: settings patches with permission awareness, secrets,
 * the TTS voice list (filled by `tts.voices` after a key is saved, R12 / 07 C22), STT models with download progress,
 * and one-at-a-time audio playback for previews and samples (object URLs revoked, playback stopped on unmount).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { CSRF_HEADER } from '@shared/api'
import { REMOTE_WRITABLE_PREFIXES, type DeepPartial, type Settings } from '@shared/settings'
import type { SttModelInfo } from '@shared/models'
import type { ModelInfo, Voice } from '@shared/types/domain'
import { toast } from '../../../components/Toast'
import { api } from '../../../lib/api'
import { ApiErrorException, parseErrorBody, toApiError } from '../../../lib/errors.logic'
import { useStore } from '../../../lib/store'
import { ws } from '../../../lib/ws'
import { players } from './players'

// ── settings ──────────────────────────────────────────────────────────────────────────────────

/** PATCH /api/settings and apply the result. Resolves false (after a toast) when refused. */
export function useSettingsPatch(): (patch: DeepPartial<Settings>) => Promise<boolean> {
  return useCallback(async (patch) => {
    try {
      const next = await api('PATCH /api/settings', { body: patch })
      useStore.getState().applySettings(next)
      return true
    } catch (e) {
      const err = toApiError(e)
      toast.error(err.code === 'forbidden' ? 'Only Vesper on your PC can change this setting.' : err.message)
      return false
    }
  }, [])
}

/** Whether this device may change `path` (07 B2: desktop, or the remote-writable list when allowed). */
export function useCanEdit(): (path: string) => boolean {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const remote = useStore((s) => s.settings?.access.remoteMayChangeSettings ?? false)
  return useCallback((path: string) => desktop || (remote && REMOTE_WRITABLE_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`))), [desktop, remote])
}

// ── secrets ───────────────────────────────────────────────────────────────────────────────────

export function useSecretSaved(name: string | null): boolean {
  return useStore((s) => (name ? (s.bootstrap?.secretsSet.includes(name) ?? false) : false))
}

function patchSecretsSet(name: string, present: boolean): void {
  const s = useStore.getState()
  const b = s.bootstrap
  if (!b) return
  const set = new Set(b.secretsSet)
  if (present) set.add(name)
  else set.delete(name)
  s.setBootstrap({ ...b, secretsSet: [...set], secretsInvalid: b.secretsInvalid.filter((x) => x !== name) })
}

/** PUT /api/secrets/:name — throws ApiErrorException (SecretInput shows it) when the provider refuses the key. */
export async function saveSecret(name: string, value: string): Promise<void> {
  await api('PUT /api/secrets/:name', { params: { name }, body: { value } })
  patchSecretsSet(name, true)
}

export async function removeSecret(name: string): Promise<void> {
  await api('DELETE /api/secrets/:name', { params: { name } })
  patchSecretsSet(name, false)
}

// ── raw audio endpoints ───────────────────────────────────────────────────────────────────────

/** Fetch audio bytes from a same-origin endpoint (sample/preview answer with raw audio, not JSON). */
export async function fetchAudio(url: string, init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {}): Promise<Blob> {
  const method = init.method ?? 'GET'
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: init.signal,
    headers: method === 'POST' ? { [CSRF_HEADER]: '1', 'content-type': 'application/json' } : {},
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  })
  if (!res.ok) {
    let parsed: unknown = null
    try {
      parsed = (await res.json()) as unknown
    } catch {
      parsed = null
    }
    throw new ApiErrorException(parseErrorBody(res.status, parsed, res.headers.get('retry-after')), res.status)
  }
  return res.blob()
}

let playerSeq = 0

/**
 * One sound at a time for this component (voice previews, "Play sample", the echo test excluded). Stops and revokes
 * everything on unmount.
 */
export function useAudioPlayer(): { play(key: string, load: (signal: AbortSignal) => Promise<Blob>): Promise<void>; stop(): void; playing: string | null; loading: string | null } {
  const cur = useRef<{ key: string; audio: HTMLAudioElement | null; url: string | null; ctrl: AbortController; id: number } | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  const stop = useCallback(() => {
    const c = cur.current
    cur.current = null
    if (!c) return
    c.ctrl.abort()
    if (c.audio) {
      c.audio.onended = null
      c.audio.onerror = null
      c.audio.pause()
      c.audio.removeAttribute('src')
      c.audio.load()
      players.players--
    }
    if (c.url) {
      URL.revokeObjectURL(c.url)
      players.urls--
    }
    setPlaying(null)
    setLoading(null)
  }, [])

  const play = useCallback(
    async (key: string, load: (signal: AbortSignal) => Promise<Blob>) => {
      stop()
      const ctrl = new AbortController()
      const me = { key, audio: null as HTMLAudioElement | null, url: null as string | null, ctrl, id: ++playerSeq }
      cur.current = me
      setLoading(key)
      try {
        const blob = await load(ctrl.signal)
        if (cur.current !== me) return
        me.url = URL.createObjectURL(blob)
        players.urls++
        const audio = new Audio(me.url)
        players.players++
        me.audio = audio
        const s = useStore.getState()
        // Test mode plays nothing audible (07 E10).
        audio.muted = __VESPER_TEST__ && s.bootstrap?.isTest === true && s.bootstrap.mute !== false
        audio.volume = s.settings?.voice.tts.volume ?? 0.9
        audio.onended = () => {
          if (cur.current === me) stop()
        }
        audio.onerror = () => {
          if (cur.current === me) {
            stop()
            toast.error("That audio couldn't be played.")
          }
        }
        setLoading(null)
        setPlaying(key)
        await audio.play()
      } catch (e) {
        if (ctrl.signal.aborted || cur.current !== me) return
        stop()
        if (e instanceof DOMException && e.name === 'NotAllowedError') toast.info('Click again to play the sound.')
        else toast.error(toApiError(e).message)
      }
    },
    [stop]
  )

  useEffect(() => stop, [stop])
  return { play, stop, playing, loading }
}

// ── TTS voices ────────────────────────────────────────────────────────────────────────────────

export interface VoicesState {
  voices: Voice[]
  models: ModelInfo[]
  quota: { used: number; limit: number } | null
  loading: boolean
  error: string | null
  /** A key was saved and the voices are on their way (`tts.voices`). */
  awaiting: boolean
}

const EMPTY_VOICES: VoicesState = { voices: [], models: [], quota: null, loading: false, error: null, awaiting: false }

/**
 * Voices + models of `provider`. Fetched when `ready` (key saved / no key needed), refreshed by the server's
 * `tts.voices` broadcast after a key save (no click needed, R12). `refresh()` bypasses the 24 h cache.
 */
export function useVoices(provider: string, ready: boolean): VoicesState & { refresh(): void; expectBroadcast(): void } {
  const [state, setState] = useState<VoicesState>(EMPTY_VOICES)
  // The provider the voices in `state` belong to. Right after a provider switch (before the reset effect runs) the
  // state still holds the previous provider's voices; they must not be offered, or auto-picked, for the new one.
  const [owner, setOwner] = useState(provider)
  const gen = useRef(0)

  const load = useCallback(
    (refresh: boolean) => {
      const g = ++gen.current
      setState((s) => ({ ...s, loading: true, error: null }))
      api('GET /api/tts/voices', { query: refresh ? { provider, refresh: '1' } : { provider } }).then(
        (r) => {
          if (g !== gen.current) return
          setOwner(provider)
          setState({ voices: r.voices, models: r.models, quota: r.quota ?? null, loading: false, error: null, awaiting: false })
        },
        (e: unknown) => {
          if (g !== gen.current) return
          const err = toApiError(e)
          const msg =
            err.code === 'forbidden' || err.upstreamStatus === 403
              ? "This key can't list voices. In ElevenLabs, give the key the “Voices: read” permission."
              : err.code === 'provider_auth'
                ? 'The voice service refused the key.'
                : err.message
          setState((s) => ({ ...s, loading: false, error: msg, awaiting: false }))
        }
      )
    },
    [provider]
  )

  useEffect(() => {
    gen.current++
    setOwner(provider)
    setState(EMPTY_VOICES)
    if (ready) load(false)
  }, [provider, ready, load])

  useEffect(
    () =>
      ws.on('tts.voices', (m) => {
        if (m.provider !== provider) return
        gen.current++
        setOwner(provider)
        setState({ voices: m.voices, models: m.models, quota: m.quota ?? null, loading: false, error: null, awaiting: false })
      }),
    [provider]
  )

  // After a key save the server broadcasts the list; if that never comes (lost socket), fetch it ourselves.
  const fallback = useRef<number | null>(null)
  useEffect(() => {
    if (!state.awaiting) return
    fallback.current = window.setTimeout(() => load(true), 8000)
    return () => {
      if (fallback.current !== null) window.clearTimeout(fallback.current)
      fallback.current = null
    }
  }, [state.awaiting, load])

  return {
    ...(owner === provider ? state : { ...EMPTY_VOICES, loading: ready }),
    refresh: () => load(true),
    expectBroadcast: () => setState((s) => ({ ...s, awaiting: true, error: null }))
  }
}

// ── STT models ────────────────────────────────────────────────────────────────────────────────

export interface ModelsState {
  models: SttModelInfo[]
  loading: boolean
  error: string | null
}

/** Local speech models with live download progress (`stt.model.progress`). */
export function useSttModels(enabled = true): ModelsState & { reload(): void; download(id: string): Promise<void>; remove(id: string): Promise<void> } {
  const [state, setState] = useState<ModelsState>({ models: [], loading: true, error: null })
  const gen = useRef(0)
  const reload = useCallback(() => {
    const g = ++gen.current
    api('GET /api/stt/models').then(
      (models) => g === gen.current && setState({ models, loading: false, error: null }),
      (e: unknown) => g === gen.current && setState((s) => ({ ...s, loading: false, error: toApiError(e).message }))
    )
  }, [])

  useEffect(() => {
    if (enabled) reload()
  }, [enabled, reload])

  useEffect(
    () =>
      ws.on('stt.model.progress', (m) => {
        setState((s) => ({
          ...s,
          models: s.models.map((x) =>
            x.id !== m.id
              ? x
              : {
                  ...x,
                  state: m.state === 'ready' ? 'installed' : m.state === 'error' ? (m.error?.code === 'conflict' ? 'not-installed' : 'error') : m.state,
                  progress: { bytes: m.bytes, total: m.total },
                  error: m.state === 'error' && m.error?.code !== 'conflict' ? m.error : undefined
                }
          )
        }))
        if (m.state === 'ready' || m.state === 'error') reload()
      }),
    [reload]
  )

  const download = useCallback(
    async (id: string) => {
      setState((s) => ({ ...s, models: s.models.map((x) => (x.id === id ? { ...x, state: 'downloading', error: undefined, progress: { bytes: 0, total: x.downloadBytes } } : x)) }))
      try {
        await api('POST /api/stt/models/:id/download', { params: { id } })
      } catch (e) {
        toast.error(toApiError(e).message)
        reload()
      }
    },
    [reload]
  )

  const remove = useCallback(
    async (id: string) => {
      try {
        await api('DELETE /api/stt/models/:id', { params: { id } })
      } catch (e) {
        toast.error(toApiError(e).message)
      }
      reload()
    },
    [reload]
  )

  return { ...state, reload, download, remove }
}
