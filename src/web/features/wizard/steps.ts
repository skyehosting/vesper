/**
 * Setup wizard steps registry (07 D11, 07 E1). Each step page is owned by its domain agent and code-split;
 * settings-wizard owns the shell (navigation, progress in `wizard.step`, summary, finale).
 *
 * `quick` marks the Quick start path (Welcome → AI provider → Start chatting); `optional` steps can be skipped (all
 * but the AI provider); skipped steps feed the empty-state setup checklist (07 D13).
 *
 * The shell renders the navigation (Back · Skip for now · Continue) under every step. A step customises it with
 * `useWizardNav()` (./nav.tsx) — e.g. disable Continue until something is chosen, relabel it, or run work first —
 * and saves its own settings as they change (features/settings/save.ts). The callbacks below stay for steps that
 * want their own buttons.
 */
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Brain, Cpu, Flag, Globe, Hand, Mic, Palette, Star, User, Volume2 } from 'lucide-react'

export interface WizardStepProps {
  /** Go to the next step (the step has saved its own settings). */
  onNext(): void
  onBack(): void
  /** Mark the step skipped and continue (optional steps only). */
  onSkip?(): void
  /** Jump to another step by id (the Summary's Edit links). */
  onGoTo?(id: string): void
}

export interface WizardStep {
  id: string
  title: string
  /** One line for the progress rail. */
  hint?: string
  icon: LucideIcon
  order: number
  quick?: boolean
  optional?: boolean
  load: () => Promise<{ default: ComponentType<WizardStepProps> }>
}

export const wizardSteps: WizardStep[] = [
  { id: 'welcome', title: 'Welcome', hint: 'Hello, and your privacy', icon: Hand, order: 0, quick: true, load: () => import('./pages/Welcome') },
  { id: 'provider', title: 'AI provider', hint: 'The service that answers', icon: Cpu, order: 10, quick: true, load: () => import('./pages/Provider') },
  { id: 'you', title: 'You', hint: 'Names and your time zone', icon: User, order: 20, optional: true, load: () => import('./pages/You') },
  { id: 'memory', title: 'Memory', hint: 'Remember across chats', icon: Brain, order: 30, optional: true, load: () => import('./pages/Memory') },
  { id: 'voice-out', title: 'Voice', hint: 'Hear the replies', icon: Volume2, order: 40, optional: true, load: () => import('../voice/WizardVoiceOut') },
  { id: 'voice-in', title: 'Microphone', hint: 'Talk instead of typing', icon: Mic, order: 50, optional: true, load: () => import('../voice/WizardVoiceIn') },
  { id: 'access', title: 'Access', hint: 'Your phone and other devices', icon: Globe, order: 60, optional: true, load: () => import('../access/WizardAccess') },
  { id: 'look', title: 'Look & presence', hint: 'Theme, accent and the Star', icon: Palette, order: 70, optional: true, load: () => import('./pages/Look') },
  { id: 'summary', title: 'Summary', hint: 'Check everything', icon: Flag, order: 80, load: () => import('./pages/Summary') },
  { id: 'finale', title: 'Hello', hint: 'Meet Vesper', icon: Star, order: 90, quick: true, load: () => import('./pages/Finale') }
].sort((a, b) => a.order - b.order)

export function wizardStep(id: string | null | undefined): WizardStep | undefined {
  return wizardSteps.find((s) => s.id === id)
}

export type WizardPath = 'quick' | 'guided'

/** The steps of a path, in order. */
export function stepsFor(path: WizardPath | null): WizardStep[] {
  return path === 'quick' ? wizardSteps.filter((s) => s.quick) : wizardSteps
}

/** Optional steps the Quick start leaves for later (they become the setup checklist). */
export function quickSkips(): string[] {
  return wizardSteps.filter((s) => s.optional).map((s) => s.id)
}
