/**
 * The wizard's one navigation bar (Back · Skip for now · Continue), shared by the shell (WizardPage) and the
 * test-only step previews (StepPreview), so a step looks and behaves the same in both. Continue always saves first:
 * the step's own `onContinue` (useWizardNav) runs, then every pending setting and every settings/secret/network
 * write still on the wire is awaited — whichever helper the step used — before the next step shows.
 */
import { useState, type ComponentType, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { Button } from '../../components/Button'
import { settleWrites } from '../../lib/api'
import { flushSettings } from '../settings/save'
import { WizardNavProvider, type WizardNavState } from './nav'
import type { WizardStepProps } from './steps'
import './wizard.css'

/** Run the step's own Continue work, then wait for its saves. False = stay on the step. */
export async function continueStep(nav: WizardNavState): Promise<boolean> {
  if (nav.onContinue) {
    const ok = await nav.onContinue()
    if (ok === false) return false
  }
  await flushSettings()
  await settleWrites()
  return true
}

export interface WizardNavBarProps {
  nav: WizardNavState
  busy: boolean
  /** Back is offered (not on the first step). */
  canGoBack: boolean
  /** The step is optional: Skip for now is offered. */
  optional: boolean
  onBack(): void
  onSkip(): void
  onContinue(): void
}

export function WizardNavBar({ nav, busy, canGoBack, optional, onBack, onSkip, onContinue }: WizardNavBarProps): ReactNode {
  const canContinue = nav.canContinue !== false
  return (
    <div className="wiz__nav">
      <div className="wiz__nav-left">
        {!nav.hideBack && canGoBack ? (
          <Button variant="ghost" icon={<ArrowLeft />} onClick={onBack} disabled={busy}>
            Back
          </Button>
        ) : null}
      </div>
      <div className="wiz__nav-right">
        {optional ? (
          <Button variant="ghost" onClick={onSkip} disabled={busy}>
            Skip for now
          </Button>
        ) : null}
        <Button variant="primary" size="lg" iconRight={<ArrowRight />} loading={busy} disabled={!canContinue} onClick={onContinue} data-testid="wizard-continue">
          {nav.continueLabel ?? 'Continue'}
        </Button>
      </div>
      {!canContinue && nav.blockedReason ? <p className="wiz__blocked">{nav.blockedReason}</p> : null}
    </div>
  )
}

/**
 * Test builds only: one step on its own page (access-ui's `/__test/access-wizard`, voice-client's `/voice-lab`,
 * memory-ui's `/test/memory-ui/wizard`) with the real navigation bar; the moves are reported through `on*`.
 */
export function StepPreview({ step: Step, onNext, onBack, onSkip }: { step: ComponentType<WizardStepProps> } & WizardStepProps): ReactNode {
  const [nav, setNav] = useState<WizardNavState>({})
  const [busy, setBusy] = useState(false)
  const next = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (await continueStep(nav)) onNext()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="wiz-preview">
      <WizardNavProvider set={setNav}>
        <Step onNext={onNext} onBack={onBack} onSkip={onSkip} />
      </WizardNavProvider>
      {nav.hideNav ? null : <WizardNavBar nav={nav} busy={busy} canGoBack optional={!!onSkip} onBack={onBack} onSkip={() => onSkip?.()} onContinue={() => void next()} />}
    </div>
  )
}
