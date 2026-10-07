/** Who may change a setting (07 B2). Separate from store/settings.logic.ts because it reads the zod-backed module. */
import { REMOTE_WRITABLE_PREFIXES } from '@shared/settings'

// ── who may write ─────────────────────────────────────────────────────────────────────────────
export interface WriteContext {
  desktop: boolean
  remoteMayChangeSettings: boolean
}

/** 07 B2: the desktop writes everything; other devices only REMOTE_WRITABLE_PREFIXES and only when allowed. */
export function canWritePath(path: string, w: WriteContext): boolean {
  if (w.desktop) return true
  if (!w.remoteMayChangeSettings) return false
  return REMOTE_WRITABLE_PREFIXES.some((pre) => path === pre || path.startsWith(`${pre}.`))
}

