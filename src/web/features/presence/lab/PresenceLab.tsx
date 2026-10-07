/**
 * '/presence-lab' (test builds + test mode only): the Star on its own, with every state, style, quality and accent a
 * click away — for the screenshot pass and the leak gates (style switches → renderer.info back to baseline). Changes
 * here are local to this page view (no settings are written).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PageProps } from '../../../app/routes'
import { applyAppearance, appearanceOf } from '../../../app/appearance'
import { Button } from '../../../components/Button'
import { Segmented } from '../../../components/Segmented'
import { useStore } from '../../../lib/store'
import type { StarQuality, StarState, StarStyle } from '../../../lib/store/presence'
import { registerTestHooks } from '../../../lib/testHooks'
import { Star } from '../Star'
import { STAR_STATE_TEXT } from '../state.logic'
import { registerTarget } from '../targets'
import './lab.css'

const STATES: StarState[] = ['idle', 'listening', 'transcribing', 'thinking', 'preparing-voice', 'speaking', 'muted', 'warming-up', 'error', 'offline']
const ACCENTS = ['gold', 'violet', 'rose', 'aurora', 'ice'] as const

export default function PresenceLab(_p: PageProps): ReactNode {
  const [state, setState] = useState<StarState | 'live'>('live')
  const [size, setSize] = useState(360)
  const [backdrop, setBackdrop] = useState(false)
  const [chrome, setChrome] = useState(true)
  const prefs = useStore((s) => s.presence.prefs)
  const settings = useStore((s) => s.settings)
  const accent = settings?.appearance.accent ?? 'gold'
  const theme = settings?.appearance.theme ?? 'dark'

  const patchAppearance = (p: { accent?: (typeof ACCENTS)[number]; theme?: 'dark' | 'light' }): void => {
    const st = useStore.getState()
    if (!st.settings) return
    const next = { ...st.settings, appearance: { ...st.settings.appearance, ...p } }
    st.applySettings(next)
    applyAppearance(appearanceOf(next), { persist: false })
  }

  useEffect(
    () =>
      registerTestHooks('presenceLab', {
        setState: (s: StarState | 'live') => setState(s),
        setAccent: (a: (typeof ACCENTS)[number]) => patchAppearance({ accent: a }),
        setTheme: (t: 'dark' | 'light') => patchAppearance({ theme: t }),
        /** The Star's square size (px). */
        setSize: (n: number) => setSize(n),
        /** v11 design pass: the presence behind a mock chat column (the avatar's real home). */
        setBackdrop: (on: boolean) => setBackdrop(on),
        /** Hide the controls for clean captures. */
        setChrome: (on: boolean) => setChrome(on)
      }),
    []
  )

  const shownState = state === 'live' ? undefined : state
  return (
    <div className={['plab', chrome ? '' : 'plab--bare'].join(' ')}>
      {backdrop ? (
        <LabBackdrop state={shownState} />
      ) : (
        <div className="plab__stage">
          <Star size={size} state={shownState} />
          {chrome ? <p className="plab__state">{state === 'live' ? 'Live state' : STAR_STATE_TEXT[state]}</p> : null}
        </div>
      )}
      {chrome ? <div className="plab__controls">
        <Segmented<StarStyle>
          aria-label="Style"
          value={prefs.style ?? settings?.appearance.star.style ?? 'armilla'}
          onChange={(style) => useStore.getState().setPresencePrefs({ style })}
          options={[
            { value: 'armilla', label: 'Armilla' },
            { value: 'orb', label: 'Orb' },
            { value: 'nebula', label: 'Nebula' },
            { value: 'minimal2d', label: '2D' },
            { value: 'off', label: 'Off' }
          ]}
        />
        <Segmented<StarQuality>
          aria-label="Quality"
          value={prefs.quality ?? 'high'}
          onChange={(quality) => useStore.getState().setPresencePrefs({ quality })}
          options={[
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]}
        />
        <Segmented
          aria-label="Theme"
          value={theme === 'light' ? 'light' : 'dark'}
          onChange={(t) => patchAppearance({ theme: t as 'dark' | 'light' })}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' }
          ]}
        />
        <div className="plab__row" role="group" aria-label="Accent">
          {ACCENTS.map((a) => (
            <Button key={a} size="sm" variant={a === accent ? 'primary' : 'secondary'} onClick={() => patchAppearance({ accent: a })}>
              {a}
            </Button>
          ))}
        </div>
        <div className="plab__row" role="group" aria-label="State">
          <Button size="sm" variant={state === 'live' ? 'primary' : 'secondary'} onClick={() => setState('live')}>
            live
          </Button>
          {STATES.map((s) => (
            <Button key={s} size="sm" variant={s === state ? 'primary' : 'secondary'} onClick={() => setState(s)}>
              {s}
            </Button>
          ))}
        </div>
      </div> : null}
    </div>
  )
}

/** A chat column with the presence centred behind the text (the layout designer's version will differ). */
function LabBackdrop({ state }: { state?: StarState }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return registerTarget(el, 'custom')
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (state) el.dataset.starState = state
    else delete el.dataset.starState
  }, [state])
  return (
    <div className="plab__chat">
      <div ref={ref} className="plab__behind" />
      <div className="plab__msgs">
        <p className="plab__user">Can you remind me what we decided about the garden layout last week?</p>
        <div className="plab__ai">
          <p>
            Of course. You settled on three raised beds along the south fence, with the tomatoes in the middle one so they get the
            longest afternoon light. The herbs go in the old half-barrel by the kitchen door, and you wanted to leave the corner by
            the shed wild for the bees.
          </p>
          <p>
            You also planned to move the compost bin closer to the beds, and to try companion planting — basil between the
            tomatoes, marigolds along the edges. If you like, I can turn that into a planting calendar for the next six weeks.
          </p>
        </div>
        <p className="plab__user">Yes please, and keep it short.</p>
        <div className="plab__ai">
          <p>
            Week 1: prepare the beds and move the compost. Week 2: sow basil and marigolds indoors. Week 3: plant the tomatoes
            out once the nights stay above 10 °C. Weeks 4–6: thin the seedlings, add the herbs, and mulch.
          </p>
        </div>
      </div>
    </div>
  )
}
