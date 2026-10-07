/**
 * Bootstrap payload and the live settings.
 *
 * `settings` is what the UI shows: the server's last confirmed settings (`settingsServer`, from bootstrap, PATCH
 * responses and `settings.changed`) with the optimistic overlay on top (`settingsOverlay`: edits Settings saved
 * instantly but the server hasn't confirmed yet — features/settings/save.ts). A `settings.changed` that arrives while
 * an edit is in flight therefore never flickers the control back. `settingsErrors` holds per-path messages of the last
 * failed save (07 D12: error → revert + field message).
 */
import type { Bootstrap } from '@shared/api'
import type { PublicSettings } from '@shared/settings'
import { applyOverlay, type Overlay } from './settings.logic'
import type { SliceCreator } from './types'

export interface SettingsSlice {
  bootstrap: Bootstrap | null
  settings: PublicSettings | null
  /** Last settings the server confirmed. */
  settingsServer: PublicSettings | null
  settingsOverlay: Overlay
  /** Dotted path → message (a reverted change, a server field error). */
  settingsErrors: Readonly<Record<string, string>>
  setBootstrap(b: Bootstrap): void
  /** Server truth (PATCH response, `settings.changed`). */
  applySettings(s: PublicSettings): void
  setSettingsOverlay(overlay: Overlay): void
  setSettingsErrors(errors: Readonly<Record<string, string>>): void
  /** A secret was saved or removed here (there is no secrets event; bootstrap's list is kept current locally). */
  markSecret(name: string, saved: boolean): void
  /** Replace the saved/invalid secret names (after a re-read of /api/bootstrap). */
  setSecrets(set: string[], invalid: string[]): void
}

export const createSettingsSlice: SliceCreator<SettingsSlice> = (set) => ({
  bootstrap: null,
  settings: null,
  settingsServer: null,
  settingsOverlay: {},
  settingsErrors: {},
  setBootstrap: (bootstrap) => set((s) => ({ bootstrap, settingsServer: bootstrap.settings, settings: applyOverlay(bootstrap.settings, s.settingsOverlay) })),
  applySettings: (server) =>
    set((s) => {
      const settings = applyOverlay(server, s.settingsOverlay)
      return { settingsServer: server, settings, bootstrap: s.bootstrap ? { ...s.bootstrap, settings: server } : s.bootstrap }
    }),
  setSettingsOverlay: (settingsOverlay) => set((s) => ({ settingsOverlay, settings: s.settingsServer ? applyOverlay(s.settingsServer, settingsOverlay) : s.settings })),
  setSettingsErrors: (settingsErrors) => set({ settingsErrors }),
  markSecret: (name, saved) =>
    set((s) => {
      if (!s.bootstrap) return {}
      const has = s.bootstrap.secretsSet.includes(name)
      if (has === saved && !s.bootstrap.secretsInvalid.includes(name)) return {}
      const secretsSet = saved ? (has ? s.bootstrap.secretsSet : [...s.bootstrap.secretsSet, name]) : s.bootstrap.secretsSet.filter((n) => n !== name)
      return { bootstrap: { ...s.bootstrap, secretsSet, secretsInvalid: s.bootstrap.secretsInvalid.filter((n) => n !== name) } }
    }),
  setSecrets: (secretsSet, secretsInvalid) => set((s) => (s.bootstrap ? { bootstrap: { ...s.bootstrap, secretsSet, secretsInvalid } } : {}))
})
