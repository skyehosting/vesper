/** Pure helpers for Settings → Performance (unit-tested in tests/unit/web/settings-wizard.test.ts). */
import type { SystemResources, UnloadVoiceResult } from '@shared/api'

export interface BudgetView {
  usedMB: number
  budgetMB: number
  /** used / budget (may exceed 1). */
  share: number
  /** Which 07 D2 budget applies right now. */
  label: string
}

/**
 * Memory in use against the 07 D2 budget that applies now: with speech recognition loaded the "+ STT" budget,
 * otherwise "window open, idle" (this page is open, so the window is). Null without budgets (standalone server).
 */
export function budgetOf(r: Pick<SystemResources, 'totalMB' | 'budgetsMB' | 'voice'>): BudgetView | null {
  if (!r.budgetsMB || typeof r.totalMB !== 'number') return null
  const stt = !!r.voice?.sttLoaded
  const budgetMB = stt ? r.budgetsMB.withStt : r.budgetsMB.windowIdle
  if (!budgetMB) return null
  const usedMB = Math.round(r.totalMB)
  return { usedMB, budgetMB, share: usedMB / budgetMB, label: stt ? 'budget with speech recognition' : 'budget for an idle window' }
}

/** The toast after "Unload voice models now". */
export function unloadedText(r: Pick<UnloadVoiceResult, 'stt' | 'wintts'>): string {
  const parts = [r.stt ? 'speech recognition' : null, r.wintts ? 'the Windows voice host' : null].filter(Boolean)
  return parts.length ? `Unloaded ${parts.join(' and ')}. They load again when next used.` : 'Nothing was loaded — voice models load when you use them.'
}
