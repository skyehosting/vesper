/**
 * Setup wizard → AI provider (07 D11 step 1, required): choose the service (presets), then the address, key, Test and
 * model in the shared ProviderEditor. Continue needs a model and, when the service wants one, a saved key; it is
 * meant after a passing Test, but "Continue anyway" lets the owner fix a failing service later. The provider's
 * privacy notice is acknowledged on Continue (07 B13).
 */
import { useState, type ReactNode } from 'react'
import { presetById } from '@shared/presets'
import type { PresetId } from '@shared/settings'
import { Button } from '../../../components/Button'
import { useStore } from '../../../lib/store'
import { setSettingRaw } from '../../settings/save'
import { PresetPicker } from '../../settings/providers/PresetPicker'
import { profileDisclosureKey, ProviderEditor, updateProfile, useProfiles } from '../../settings/providers/ProviderEditor'
import { newProfile, profileReady, secretName, withPreset } from '../../settings/providers/providers.logic'
import { useWizardNav } from '../nav'
import type { WizardStepProps } from '../steps'

export default function WizardProvider({ onNext }: WizardStepProps): ReactNode {
  const profiles = useProfiles()
  const defaultId = useStore((s) => s.settings?.llm.defaultProfile ?? null)
  const secretsSet = useStore((s) => s.bootstrap?.secretsSet ?? [])
  const profile = profiles.find((p) => p.id === defaultId) ?? profiles[0] ?? null
  const [tested, setTested] = useState<boolean | null>(null)

  const choose = (id: PresetId): void => {
    setTested(null)
    if (!profile) {
      const p = newProfile(
        id,
        profiles.map((x) => x.id)
      )
      setSettingRaw('llm.profiles', [...profiles, p], { immediate: true })
      setSettingRaw('llm.defaultProfile', p.id, { immediate: true })
      return
    }
    if (profile.preset === id) return
    updateProfile(profile.id, withPreset(profile, id), { immediate: true })
    if (!defaultId) setSettingRaw('llm.defaultProfile', profile.id, { immediate: true })
  }

  const preset = profile ? presetById(profile.preset) : null
  const ready = !!profile && !!preset && profileReady(profile, preset, secretsSet.includes(secretName(profile.id)))

  const acknowledge = (): void => {
    const s = useStore.getState().settings
    const key = profile ? profileDisclosureKey(profile) : null
    if (s && key) setSettingRaw('privacy.acknowledged', { ...s.privacy.acknowledged, [key]: Date.now() }, { immediate: true })
  }

  useWizardNav({
    canContinue: ready && tested === true,
    blockedReason: !profile
      ? 'Choose a service to continue.'
      : !ready
        ? preset?.keyRequired && !secretsSet.includes(secretName(profile.id))
          ? 'Save your API key and choose a model to continue.'
          : 'Choose a model to continue.'
        : 'Test the connection to continue.',
    onContinue: () => {
      acknowledge()
      return true
    }
  })

  return (
    <div className="wiz-step">
      <header className="wiz-step__head">
        <h1 className="wiz-step__title" tabIndex={-1}>
          Which AI should answer?
        </h1>
        <p className="wiz-step__lead">Vesper uses your own account with an AI service — or a model running on this PC. You can add more later.</p>
      </header>

      <PresetPicker value={profile?.preset ?? null} onChange={choose} />

      {profile ? (
        <section className="wiz-panel" aria-label={`${profile.label} connection`}>
          <ProviderEditor profileId={profile.id} mode="wizard" onTest={setTested} />
          {ready && tested === false ? (
            <div className="wiz-panel__anyway">
              <span>Still not working? You can finish setup now and fix it in Settings → AI providers.</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  acknowledge()
                  onNext()
                }}
              >
                Continue anyway
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}
