/**
 * Setup wizard step 3 — Memory (07 D11; R7, R21): optional; "kept on this PC"; the Voyage key with Test (the server
 * validates a key with a real 256-dimension embed; Test repeats it on demand, 10 s timeout); the default scope
 * (linked-only recommended / all chats); the privacy note with the "$5" correction and the opt-out links. Each choice
 * saves at once (per-step saving; the shell's Continue waits for those writes); Skip leaves memory off. Navigation is
 * the shell's one bar (useWizardNav); Continue reads "Continue without a key" while memory is on with no key.
 */
import type { ReactNode } from 'react'
import { LeavesPcBadge } from '../../../components/Badge'
import { Callout } from '../../../components/Callout'
import { Switch } from '../../../components/Switch'
import { Select } from '../../../components/Select'
import { ScopeChoice } from '../../memory/MemoryParts'
import { VoyageKey } from '../../memory/VoyageConnection'
import { VoyagePrivacy } from '../../memory/VoyagePrivacy'
import { usePatchSettings, useSecretSet, useSettings, voyageKeyKnown } from '../../memory/settings'
import { useLive } from '../../memory/live'
import { memoryStatus } from '../../memory/stores'
import { EMBED_CHOICES } from '../../memory/voyage.logic'
import { useWizardNav } from '../nav'
import type { WizardStepProps } from '../steps'
import '../../memory/layout.css'
import '../../memory/memory.css'
import '../../privacy/privacy.css'

export default function WizardMemory(_props: WizardStepProps): ReactNode {
  const settings = useSettings()
  const patch = usePatchSettings()
  const { saved: secretSaved } = useSecretSet('voyage')
  const { data: status } = useLive(memoryStatus)
  const saved = voyageKeyKnown(secretSaved, status?.state)
  const enabled = settings?.memory.enabled ?? false
  useWizardNav({ continueLabel: enabled && !saved ? 'Continue without a key' : 'Continue' })
  if (!settings) return null
  const m = settings.memory

  return (
    <div className="wiz-step wmem" data-testid="wizard-memory">
      {/* The shared step header (fix5-ui P11): eyebrow, title, lead — the same left edge as every other step. */}
      <header className="wiz-step__head">
        <p className="wiz-step__eyebrow">Memory · optional</p>
        <h1 className="wiz-step__title" tabIndex={-1}>
          Memory
        </h1>
        <p className="wiz-step__lead">
          Vesper keeps every conversation on this PC as a timeline. With Voyage AI it can also find what you meant — even in other words — and bring it back
          when it matters. You can turn it on later in Settings.
        </p>
      </header>

      <div className="wmem__card">
        <Switch
          checked={m.enabled}
          onChange={(v) => void patch({ memory: { enabled: v } })}
          label={
            <span className="mlabel">
              Remember with Voyage AI <LeavesPcBadge service="Voyage AI" />
            </span>
          }
          description="Uses your own Voyage AI key. New accounts get 200 million free tokens; after that it costs about $0.02 per million."
        />
      </div>

      {m.enabled ? (
        <>
          <div className="wmem__card">
            <VoyageKey />
            <Select
              label="Model"
              value={m.voyage.embedModel}
              onChange={(v) => void patch({ memory: { voyage: { embedModel: v } } })}
              options={EMBED_CHOICES.map((c) => ({ value: c.id, label: c.label, description: c.description, meta: `$${c.usdPerMTok.toFixed(2)} / 1M` }))}
              hint="voyage-4-lite is plenty for conversations."
            />
          </div>
          <div className="wmem__card">
            <p className="wmem__label">What can a chat remember?</p>
            <ScopeChoice value={m.scopeDefault} onChange={(v) => void patch({ memory: { scopeDefault: v } })} />
          </div>
          {!saved ? <Callout tone="info">Without a key, memory still works with exact words. You can add the key later.</Callout> : null}
        </>
      ) : null}

      <VoyagePrivacy />
    </div>
  )
}
