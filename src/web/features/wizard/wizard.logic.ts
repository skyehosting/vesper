/**
 * Wizard navigation and the setup checklist, as pure functions (07 D11/D13): where to resume after a restart, the
 * next/previous step of a path, the skipped list, and which checklist items are still open. Unit-tested.
 */
import { defaultSettings, type Settings } from '@shared/settings'

export const QUICK_IDS = ['welcome', 'provider', 'finale'] as const
export const GUIDED_IDS = ['welcome', 'provider', 'you', 'memory', 'voice-out', 'voice-in', 'access', 'look', 'summary', 'finale'] as const
export const OPTIONAL_IDS = ['you', 'memory', 'voice-out', 'voice-in', 'access', 'look'] as const

export function idsFor(path: 'quick' | 'guided' | null): readonly string[] {
  return path === 'quick' ? QUICK_IDS : GUIDED_IDS
}

/** The step to show when the wizard opens: the saved one if it belongs to the path, else Welcome. */
export function resumeStep(w: Pick<Settings['wizard'], 'step' | 'path' | 'completed'>, rerun: boolean): string {
  if (rerun) return 'welcome'
  if (w.step && idsFor(w.path).includes(w.step)) return w.step
  return 'welcome'
}

export function nextStep(path: 'quick' | 'guided' | null, current: string): string | null {
  const ids = idsFor(path)
  const i = ids.indexOf(current)
  return i >= 0 && i < ids.length - 1 ? ids[i + 1] : null
}

export function prevStep(path: 'quick' | 'guided' | null, current: string): string | null {
  const ids = idsFor(path)
  const i = ids.indexOf(current)
  return i > 0 ? ids[i - 1] : null
}

export function withSkipped(skipped: readonly string[], id: string): string[] {
  return skipped.includes(id) ? [...skipped] : [...skipped, id]
}

export function withoutSkipped(skipped: readonly string[], id: string): string[] {
  return skipped.filter((s) => s !== id)
}

export interface ChecklistItem {
  id: string
  title: string
  description: string
  /** Settings section to finish it in. */
  section: string
  done: boolean
}

const ITEMS: Record<string, Omit<ChecklistItem, 'done'>> = {
  you: { id: 'you', title: 'Tell Vesper your name', description: 'And check your time zone.', section: 'general' },
  memory: { id: 'memory', title: 'Turn on memory', description: 'Let Vesper recall earlier conversations.', section: 'memory' },
  'voice-out': { id: 'voice-out', title: 'Give Vesper a voice', description: 'Hear replies, in time with the text.', section: 'voice-out' },
  'voice-in': { id: 'voice-in', title: 'Talk instead of typing', description: 'Set up the microphone.', section: 'voice-in' },
  access: { id: 'access', title: 'Use Vesper on your phone', description: 'Reach it from your other devices.', section: 'access' },
  look: { id: 'look', title: 'Make it yours', description: 'Theme, accent and the Star.', section: 'appearance' }
}

function isDone(id: string, s: Settings): boolean {
  switch (id) {
    case 'you':
      return s.profile.userName.trim().length > 0
    case 'memory':
      return s.memory.enabled
    case 'voice-out':
      return s.voice.tts.enabled
    case 'voice-in':
      return s.voice.stt.enabled
    case 'access':
      return s.access.mode !== 'local'
    case 'look': {
      // Done once anything differs from the shipped look (defaults live only in the shared schema, 07 E12).
      const d = defaultSettings().appearance
      return s.appearance.theme !== d.theme || s.appearance.accent !== d.accent || s.appearance.star.style !== d.star.style
    }
    default:
      return true
  }
}

/** The checklist for the first chat's empty state: skipped steps, each ticked once it's set up elsewhere. */
export function checklistItems(s: Settings): ChecklistItem[] {
  if (s.wizard.checklistDismissed) return []
  return s.wizard.skipped.filter((id) => ITEMS[id]).map((id) => ({ ...ITEMS[id], done: isDone(id, s) }))
}

/** Show the checklist only while something is left to do. */
export function checklistOpen(items: readonly ChecklistItem[]): boolean {
  return items.some((i) => !i.done)
}
