/**
 * Instant save for Settings and the wizard (07 D12): every control writes through `setSetting(path, value)`.
 *
 * - optimistic: the store shows the new value at once (an overlay over the server's settings);
 * - debounced: changes within DEBOUNCE_MS go out as one `PATCH /api/settings` (toggles pass `immediate`);
 * - one request at a time; changes made meanwhile wait for the next one;
 * - error → the overlay entries of that request are dropped (the control reverts to the server value) and each path
 *   gets a message from `ApiError.fields` (or the general message) in `settingsErrors`;
 * - a change that may move a provider key to another origin re-reads the saved-key list (the server clears keys whose
 *   address changed, 07 B1).
 *
 *   const { value, set, error, readOnly } = useSetting('chat.pageSize')
 */
import { useCallback } from 'react'
import type { DeepPartial, Settings } from '@shared/settings'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import {
  fieldErrorsFor,
  getAt,
  isAppearancePath,
  movesKeys,
  settleOverlay,
  toPatch,
  type Overlay,
  type SettingPath,
  type ValueAt
} from '../../lib/store/settings.logic'
import { appearanceOf, applyAppearance } from '../../app/appearance'
import { canWritePath } from './write.logic'
import { kitStats } from '../../components/internal/stats'
import { registerTestHooks } from '../../lib/testHooks'

export const DEBOUNCE_MS = 400

let pending: Record<string, unknown> = {}
let timer: number | null = null
let inflight: Promise<void> | null = null
let listening = false
/** Resolvers of flushSettings() calls waiting for everything to be on the server. */
let idleWaiters: Array<() => void> = []

function restyle(): void {
  const s = useStore.getState().settings
  if (s) applyAppearance(appearanceOf(s))
}

function schedule(ms: number): void {
  if (timer !== null) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    timer = null
    void flush()
  }, ms)
}

/** Page-lifetime listener (installed once): a pending change is sent before the page is hidden or closed. */
function listenOnce(): void {
  if (listening) return
  listening = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && Object.keys(pending).length) void flush()
  })
}

export interface SetOptions {
  /** Send now (switches, choices); text and sliders debounce. */
  immediate?: boolean
}

/** Change one setting (optimistically) and save it. */
export function setSetting<P extends SettingPath>(path: P, value: ValueAt<Settings, P>, o: SetOptions = {}): void {
  setSettingRaw(path, value, o)
}

/** Untyped variant for array-item paths and generic controls. */
export function setSettingRaw(path: string, value: unknown, o: SetOptions = {}): void {
  listenOnce()
  const st = useStore.getState()
  st.setSettingsOverlay({ ...st.settingsOverlay, [path]: value })
  if (Object.keys(st.settingsErrors).some((k) => k === path || k.startsWith(`${path}.`))) {
    const errs: Record<string, string> = {}
    for (const [k, v] of Object.entries(st.settingsErrors)) if (!(k === path || k.startsWith(`${path}.`))) errs[k] = v
    st.setSettingsErrors(errs)
  }
  pending = { ...pending, [path]: value }
  if (isAppearancePath(path)) restyle()
  schedule(o.immediate ? 0 : DEBOUNCE_MS)
}

async function flush(): Promise<void> {
  if (inflight) return
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
  const sent: Overlay = pending
  pending = {}
  const paths = Object.keys(sent)
  if (!paths.length) {
    settleIdle()
    return
  }
  inflight = (async () => {
    try {
      const server = await api('PATCH /api/settings', { body: toPatch(sent) as DeepPartial<Settings> })
      const st = useStore.getState()
      st.setSettingsOverlay(settleOverlay(st.settingsOverlay, sent))
      st.applySettings(server)
      if (paths.some(movesKeys)) void refreshSecrets()
    } catch (e) {
      const err = toApiError(e)
      const st = useStore.getState()
      st.setSettingsOverlay(settleOverlay(st.settingsOverlay, sent))
      st.setSettingsErrors({ ...st.settingsErrors, ...fieldErrorsFor(paths, err.message, err.fields) })
    } finally {
      if (paths.some(isAppearancePath)) restyle()
    }
  })()
  try {
    await inflight
  } finally {
    inflight = null
    if (Object.keys(pending).length) void flush()
    else settleIdle()
  }
}

function settleIdle(): void {
  if (inflight || timer !== null || Object.keys(pending).length) return
  const w = idleWaiters
  idleWaiters = []
  for (const r of w) r()
}

/**
 * Send pending changes now and wait until nothing is in flight (the wizard's Continue; saving a key that needs its
 * profile on the server first). Resolves even when the save failed — read `settingsErrors` for that.
 */
export function flushSettings(): Promise<void> {
  return new Promise<void>((resolve) => {
    idleWaiters.push(resolve)
    if (inflight) return
    void flush()
  })
}

/** Errors of the last failed save at `path` (and below it). */
export function errorAt(errors: Readonly<Record<string, string>>, path: string): string | undefined {
  return errors[path]
}

/** Re-read which keys are saved (after a base-URL change; the server may have cleared one). */
export async function refreshSecrets(): Promise<void> {
  try {
    const b = await api('GET /api/bootstrap')
    useStore.getState().setSecrets(b.secretsSet, b.secretsInvalid)
  } catch {
    // stays as it was; the next bootstrap fixes it
  }
}

export interface WriteState {
  readOnly: boolean
  /** Why it can't be changed here ("Change this in the Vesper app on your PC."). */
  reason: string | null
}

/** May this device change `path`? (07 B2) */
export function useCanWrite(path: string): WriteState {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  const remote = useStore((s) => s.settings?.access.remoteMayChangeSettings ?? false)
  const ok = canWritePath(path, { desktop, remoteMayChangeSettings: remote })
  return { readOnly: !ok, reason: ok ? null : 'Change this in the Vesper app on your PC.' }
}

export interface UseSetting<T> extends WriteState {
  value: T
  set(value: T, o?: SetOptions): void
  error: string | undefined
}

/** One setting, bound: current value (with optimistic edits), setter, last error, and whether this device may write. */
export function useSetting<P extends SettingPath>(path: P): UseSetting<ValueAt<Settings, P>> {
  const value = useStore((s) => getAt(s.settings, path)) as ValueAt<Settings, P>
  const error = useStore((s) => s.settingsErrors[path])
  const w = useCanWrite(path)
  const set = useCallback((v: ValueAt<Settings, P>, o?: SetOptions) => setSetting(path, v, o), [path])
  return { value, set, error, ...w }
}

/** Nothing pending or in flight (e2e waits on it). */
export function saveIdle(): boolean {
  return !inflight && timer === null && Object.keys(pending).length === 0
}

if (__VESPER_TEST__) registerTestHooks('settings', { saveIdle, kit: () => kitStats() })
