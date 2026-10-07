/**
 * Setup wizard step 6 — Access (07 D11, research 06 §9.3): "Use Vesper on other devices?" This PC only is the
 * default; Local network or Tailscale need a password, which is set right here (the only place the wizard asks for
 * one). The wizard's one navigation bar drives it (useWizardNav): Continue saves the mode first and stays on the step
 * if that fails. The details (firewall, Tailscale, pairing) live in Settings → Access & security, and the finale
 * offers to pair a phone.
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { AccessMode } from '@shared/types/domain'
import { Callout } from '../../components/Callout'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { useWizardNav } from '../wizard/nav'
import type { WizardStepProps } from '../wizard/steps'
import { firewallSwitchNote } from './access.logic'
import { refreshNetwork, updateNetwork } from './data'
import { CapabilityMatrix, ModePicker } from './ModePicker'
import { PasswordForm } from './PasswordForm'
import { TrayCallout } from './TrayCallout'
import './access.css'

export default function WizardAccess(_props: WizardStepProps): ReactNode {
  const network = useStore((s) => s.network ?? s.bootstrap?.network ?? null)
  const [mode, setMode] = useState<AccessMode>(network?.mode ?? 'local')
  const [error, setError] = useState<string | null>(null)
  const passwordSet = network?.passwordSet ?? false
  const needsPassword = mode !== 'local' && !passwordSet
  const firewallNote = firewallSwitchNote(network?.mode ?? 'local', mode, network?.lan)

  useEffect(() => {
    const ctrl = new AbortController()
    refreshNetwork(ctrl.signal).catch(() => undefined)
    return () => ctrl.abort()
  }, [])

  useWizardNav({
    canContinue: !needsPassword,
    blockedReason: 'Set a password above to continue, or choose This PC only.',
    onContinue: async () => {
      setError(null)
      try {
        const now = useStore.getState().network ?? network
        if (!now || now.mode !== mode) await updateNetwork({ mode })
        return true
      } catch (e) {
        const err = toApiError(e)
        setError(err.fields?.mode ?? err.message)
        return false
      }
    }
  })

  return (
    <div className="acc acc--wizard" data-testid="wizard-access">
      <header className="acc-head">
        <h1 className="wiz-step__title" tabIndex={-1}>
          Use Vesper on other devices?
        </h1>
        <p className="acc-head__lead">Vesper always works on this PC. You can also open it on your phone or laptop — at home, or anywhere with Tailscale. You can change this any time in Settings.</p>
      </header>

      <ModePicker value={mode} current={network?.mode} onChange={setMode} portable={network?.portable} label="Where you can use Vesper" />
      {firewallNote ? <p className="acc-muted">{firewallNote}</p> : null}
      <CapabilityMatrix selected={mode} />

      {mode !== 'local' ? (
        <section className="acc-section" aria-labelledby="acc-wiz-pw">
          <h2 id="acc-wiz-pw" className="acc-section__title">
            {passwordSet ? 'Password' : 'Choose a password'}
          </h2>
          {passwordSet ? (
            <p className="acc-status-line">
              <span className="acc-dot acc-dot--ok" aria-hidden="true" />A password is set. Other devices sign in with it, or you pair them from this PC.
            </p>
          ) : (
            <>
              <p className="acc-section__lead">Other devices sign in with it. The app on this PC never asks for it.</p>
              <PasswordForm isSet={false} desktop submitLabel="Set password" />
            </>
          )}
          {mode === 'lan' ? (
            <Callout tone="info">Phones show a certificate warning the first time; Settings → Access &amp; security shows the fingerprint to compare.</Callout>
          ) : (
            <Callout tone="info">Install Tailscale on this PC and on your phone, and sign in to both with the same account. Settings → Access &amp; security walks you through the rest.</Callout>
          )}
        </section>
      ) : null}

      {mode !== 'local' ? <TrayCallout /> : null}

      {error ? (
        <p className="acc-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
