/**
 * Test builds only ('/__test/access-wizard', routes.ts testOnly): the wizard's Access step on its own, so e2e and
 * screenshots can exercise it on its own, with the wizard's real navigation bar (StepPreview). Never in a release build (07 B10).
 */
import type { ReactNode } from 'react'
import { toast } from '../../components/Toast'
import type { PageProps } from '../../app/routes'
import { StepPreview } from '../wizard/NavBar'
import WizardAccess from './WizardAccess'

export default function WizardPreview(_props: PageProps): ReactNode {
  return (
    <div className="acc-preview">
      <StepPreview step={WizardAccess} onNext={() => toast.info('Next step')} onBack={() => toast.info('Previous step')} onSkip={() => toast.info('Skipped')} />
    </div>
  )
}
