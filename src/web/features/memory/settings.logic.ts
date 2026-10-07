/** Pure settings helpers (07 B2 edit rules, PATCH merge). */
import { REMOTE_WRITABLE_PREFIXES, type PublicSettings } from '@shared/settings'

/** Whether this device may change `path` (desktop always; others only the remote-writable prefixes when allowed). */
export function canEditPath(path: string, desktop: boolean, settings: PublicSettings | null): boolean {
  if (desktop) return true
  if (!settings?.access.remoteMayChangeSettings) return false
  return REMOTE_WRITABLE_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`))
}

/** Deep merge of a PATCH body into settings (objects merge, arrays and scalars replace) — the server's rule. */
export function mergeSettings<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch) || typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = mergeSettings((base as Record<string, unknown>)[k], v)
  return out as T
}
