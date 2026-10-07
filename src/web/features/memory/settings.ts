/**
 * Settings access for the memory/privacy/data pages: read from the store (bootstrap + `settings.changed`), write with
 * PATCH /api/settings and apply the response at once so the page never shows a stale value. Desktop-only paths
 * (07 B2) are read-only on other devices: `canEdit` says so before the server has to refuse.
 */
import { useCallback } from 'react'
import type { DeepPartial, PublicSettings, Settings } from '@shared/settings'
import { canEditPath, mergeSettings } from './settings.logic'

export { canEditPath, mergeSettings }
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'

export function useSettings(): PublicSettings | null {
  return useStore((s) => s.settings)
}

export function useIsDesktop(): boolean {
  return useStore((s) => s.bootstrap?.desktop ?? false)
}

export function useSecretSet(name: string): { saved: boolean; invalid: boolean } {
  const saved = useStore((s) => s.bootstrap?.secretsSet.includes(name) ?? false)
  const invalid = useStore((s) => s.bootstrap?.secretsInvalid.includes(name) ?? false)
  return { saved, invalid }
}

/** Mark a secret saved/removed in the local bootstrap copy (the server never echoes secret names back on its own). */
export function markSecret(name: string, saved: boolean): void {
  const st = useStore.getState()
  const b = st.bootstrap
  if (!b) return
  const set = new Set(b.secretsSet)
  if (saved) set.add(name)
  else set.delete(name)
  st.setBootstrap({ ...b, secretsSet: [...set], secretsInvalid: b.secretsInvalid.filter((n) => n !== name), settings: st.settings ?? b.settings })
}

export function useCanEdit(path: string): boolean {
  const desktop = useIsDesktop()
  const settings = useSettings()
  return canEditPath(path, desktop, settings)
}

/**
 * Save a change. The page shows it at once (optimistic) and settles on the server's answer; a refusal puts the
 * previous settings back.
 */
export async function patchSettings(body: DeepPartial<Settings>): Promise<PublicSettings> {
  const st = useStore.getState()
  const before = st.settings
  if (before) st.applySettings(mergeSettings(before, body))
  try {
    const next = await api('PATCH /api/settings', { body })
    useStore.getState().applySettings(next)
    return next
  } catch (e) {
    if (before) useStore.getState().applySettings(before)
    throw e
  }
}

/** `patch(body)` → true when saved; a failure shows a toast and returns false. */
export function usePatchSettings(): (body: DeepPartial<Settings>) => Promise<boolean> {
  return useCallback(async (body) => {
    try {
      await patchSettings(body)
      return true
    } catch (e) {
      toast.error(toApiError(e).message, { title: "Couldn't save that setting" })
      return false
    }
  }, [])
}

/**
 * Whether a Voyage key is saved. Bootstrap's list is a snapshot; a key saved on another device (or after this page
 * loaded) shows up in the live memory status instead ('keyword-only' = memory on without a key).
 */
export function voyageKeyKnown(secretSaved: boolean, state: string | null | undefined): boolean {
  if (secretSaved) return true
  return state !== undefined && state !== null && state !== 'keyword-only' && state !== 'disabled'
}
