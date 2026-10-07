/**
 * Test builds only ('/test/memory-ui/:view', testOnly — 07 B10): memory-ui parts that live inside other agents'
 * shells, shown on their own so their look and flow can be checked in this build:
 *   wizard  — wizard step 3 (the wizard shell is settings-wizard's)
 *   picker  — the session panel's prompt-library menu (?session=<uid>; the panel is sessions-ui's)
 */
import type { ReactNode } from 'react'
import type { PageProps } from '../../app/routes'
import { toast } from '../../components/Toast'
import { getLocation } from '../../lib/router'
import WizardMemory from '../wizard/pages/Memory'
import { StepPreview } from '../wizard/NavBar'
import { PromptPicker } from '../prompts/PromptPicker'

export default function TestPreview({ params }: PageProps): ReactNode {
  if (params.view === 'picker') {
    const session = new URLSearchParams(getLocation().search).get('session') ?? ''
    return (
      <div className="wprev" data-testid="picker-preview">
        <PromptPicker sessionUid={session} currentPrompt="Be brief and kind." currentPromptId={null} />
      </div>
    )
  }
  return (
    <div className="wprev">
      <StepPreview step={WizardMemory} onNext={() => toast.info('next')} onBack={() => toast.info('back')} onSkip={() => toast.info('skip')} />
    </div>
  )
}
