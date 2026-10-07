/**
 * Setup wizard → Welcome (07 D11 step 0): the Star, what Vesper is, the layered privacy notice (07 B13: the short
 * text, then "what leaves this PC" in detail), and the choice of Quick start or Guided setup.
 */
import { useState, type ReactNode } from 'react'
import { ArrowRight, Compass, Rocket } from 'lucide-react'
import { ackKey, disclosure } from '@shared/privacy'
import { Button } from '../../../components/Button'
import { Disclosure } from '../../../components/Disclosure'
import { RadioGroup } from '../../../components/RadioGroup'
import { Star } from '../../presence'
import { useStore } from '../../../lib/store'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { SHORT_WINDOW } from '../nav'
import { setSetting, setSettingRaw } from '../../settings/save'
import { useWizardNav } from '../nav'
import { quickSkips, type WizardPath, type WizardStepProps } from '../steps'

export default function WizardWelcome({ onNext }: WizardStepProps): ReactNode {
  const saved = useStore((s) => s.settings?.wizard.path ?? null)
  const name = useStore((s) => s.settings?.profile.assistantName || 'Vesper')
  const [path, setPath] = useState<WizardPath>(saved ?? 'guided')
  const short = useMediaQuery(SHORT_WINDOW)
  useWizardNav({ hideNav: true })
  const welcome = disclosure('welcome')

  const start = (): void => {
    const s = useStore.getState().settings
    setSetting('wizard.path', path, { immediate: true })
    setSetting('wizard.skipped', path === 'quick' ? quickSkips() : [], { immediate: true })
    // The layered notice was shown here: remember that it was (07 B13, keyed id@version).
    if (welcome && s) setSettingRaw('privacy.acknowledged', { ...s.privacy.acknowledged, [ackKey(welcome)]: Date.now() }, { immediate: true })
    onNext()
  }

  return (
    <div className="wiz-welcome">
      <div className="wiz-welcome__star">
        <Star size={short ? 84 : 132} state="idle" />
      </div>
      <h1 className="wiz-welcome__title" tabIndex={-1}>
        Hello. I&rsquo;m {name}.
      </h1>
      <p className="wiz-welcome__lead">An AI companion that lives on your PC — it remembers, speaks, and you can reach it from your other devices.</p>

      <div className="wiz-welcome__privacy">
        <p>{welcome?.summary ?? 'Your chats are stored on this PC.'}</p>
        <Disclosure summary="What leaves this PC?" className="wiz-welcome__more">
          <ul className="wiz-list">
            <li>
              <strong>Your AI service</strong> receives your messages, attachments and anything recalled from memory, to write each reply.
            </li>
            <li>
              <strong>Memory (optional)</strong>: Voyage AI turns text into searchable numbers. Your memories stay on this PC; searches may send up to 40 earlier
              messages for ranking.
            </li>
            <li>
              <strong>Voice (optional)</strong>: a voice service such as ElevenLabs receives the text it speaks. Windows voices stay on this PC.
            </li>
            <li>
              <strong>Microphone</strong>: speech is turned into text on this PC by an open-source model.
            </li>
            <li>Keys are encrypted on this PC and sent only to the address you saved them for. Each service&rsquo;s own terms are shown when you choose it.</li>
          </ul>
        </Disclosure>
      </div>

      <RadioGroup<WizardPath>
        className="wiz-welcome__paths"
        label="How would you like to set up?"
        variant="cards"
        columns={2}
        value={path}
        onChange={setPath}
        options={[
          { value: 'quick', label: 'Quick start', description: 'Connect an AI service and start chatting. About a minute.', icon: <Rocket /> },
          { value: 'guided', label: 'Guided setup', description: 'Also memory, voice, microphone, your phone and the look. About five minutes.', icon: <Compass /> }
        ]}
      />

      <Button variant="primary" size="lg" iconRight={<ArrowRight />} onClick={start} className="wiz-welcome__go">
        {path === 'quick' ? 'Start quick setup' : 'Start guided setup'}
      </Button>
    </div>
  )
}
