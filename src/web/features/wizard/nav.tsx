/**
 * The wizard's navigation bar is the shell's (Back · Skip for now · Continue). A step adjusts it while mounted:
 *
 *   useWizardNav({ canContinue: ready, continueLabel: 'Looks good', onContinue: async () => { await save(); return true } })
 *
 * `onContinue` may return false to stay on the step. Everything resets when the step unmounts.
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'

export interface WizardNavState {
  /** Continue is enabled (default true). */
  canContinue?: boolean
  continueLabel?: string
  /** Shown under the bar while Continue is disabled ("Choose a model to continue"). */
  blockedReason?: string
  /** Runs before moving on; false keeps the step. */
  onContinue?: () => boolean | void | Promise<boolean | void>
  /** The step shows its own buttons (the Welcome choice, the finale). */
  hideNav?: boolean
  /** Hide only Back. */
  hideBack?: boolean
}

/** Short windows (the owner's 1138×608 monitor): smaller Star, tighter spacing (matches wizard.css). */
export const SHORT_WINDOW = '(max-height: 760px)'

type Setter = (s: WizardNavState) => void

const NavContext = createContext<Setter | null>(null)

export function WizardNavProvider({ set, children }: { set: Setter; children: ReactNode }): ReactNode {
  return <NavContext.Provider value={set}>{children}</NavContext.Provider>
}

export function useWizardNav(state: WizardNavState): void {
  const set = useContext(NavContext)
  // The latest onContinue is read through a ref so a step can pass a fresh closure each render without re-registering.
  const cb = useRef(state.onContinue)
  cb.current = state.onContinue
  const { canContinue, continueLabel, blockedReason, hideNav, hideBack } = state
  const hasCb = state.onContinue !== undefined
  useEffect(() => {
    if (!set) return
    set({ canContinue, continueLabel, blockedReason, hideNav, hideBack, onContinue: hasCb ? () => cb.current?.() : undefined })
  }, [set, canContinue, continueLabel, blockedReason, hideNav, hideBack, hasCb])
  useEffect(() => () => set?.({}), [set])
}
