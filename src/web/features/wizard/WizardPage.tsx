/**
 * '/setup' — the setup wizard (R3, 07 D11). Quick start (Welcome → AI provider → Hello, under a minute) or Guided
 * (0 Welcome · 1 AI provider · 2 You · 3 Memory · 4 Voice · 5 Microphone · 6 Access · 7 Look · 8 Summary · finale).
 *
 * - The position is saved on every move (`wizard.step`, `wizard.path`), so a restart resumes on the same step;
 *   `?rerun=1` (Settings → General → Run setup again) starts at Welcome.
 * - Every step but the AI provider can be skipped; skipped steps feed the setup checklist (07 D13).
 * - Desktop window only (07 D11): other devices see "Finish setup on your PC".
 * - The shell owns the one navigation bar (./NavBar.tsx); steps adjust it with useWizardNav (./nav.tsx). Continue runs
 *   the step's own work, then waits for its saves (pending settings and settings/secret/network writes).
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react'
import { Check, Download, Monitor } from 'lucide-react'
import { Button } from '../../components/Button'
import { Spinner } from '../../components/Spinner'
import { Star } from '../presence'
import type { PageProps } from '../../app/routes'
import { navigate, useLocation } from '../../lib/router'
import { useStore } from '../../lib/store'
import { registerTestHooks } from '../../lib/testHooks'
import { ws } from '../../lib/ws'
import { setSetting } from '../settings/save'
import { continueStep, WizardNavBar } from './NavBar'
import { WizardNavProvider, type WizardNavState } from './nav'
import { wizardStep, wizardSteps, type WizardStep, type WizardStepProps } from './steps'
import { idsFor, nextStep, prevStep, resumeStep, withSkipped, withoutSkipped } from './wizard.logic'
import './wizard.css'

const pages = new Map<string, LazyExoticComponent<ComponentType<WizardStepProps>>>()
function pageFor(step: WizardStep): LazyExoticComponent<ComponentType<WizardStepProps>> {
  let p = pages.get(step.id)
  if (!p) {
    p = lazy(step.load)
    pages.set(step.id, p)
  }
  return p
}

/** The step currently shown, for e2e (`__vesperTest.wizard.step()`). */
let shownStep: string | null = null

if (__VESPER_TEST__) registerTestHooks('wizard', { step: () => shownStep })

export default function WizardPage(_props: PageProps): ReactNode {
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  if (!desktop) return <RemoteNotice />
  return <Wizard />
}

function RemoteNotice(): ReactNode {
  return (
    <div className="wiz wiz--remote">
      <div className="wiz__sky" aria-hidden="true" />
      <div className="wiz-remote">
        <Star size={72} state="idle" />
        <h1 className="wiz-remote__title">Finish setup on your PC</h1>
        <p className="wiz-remote__text">Setup connects your AI service and keys, so it runs only in the Vesper app on your PC. Open Vesper there to continue.</p>
        <Button icon={<Monitor />} onClick={() => navigate('/', { replace: true })}>
          Go to my chats
        </Button>
      </div>
    </div>
  )
}

function Wizard(): ReactNode {
  const wiz = useStore((s) => s.settings?.wizard)
  const { search } = useLocation()
  const rerun = new URLSearchParams(search).get('rerun') === '1'
  const [step, setStep] = useState<string>(() => resumeStep(wiz ?? { step: null, path: null, completed: false }, rerun))
  const [dir, setDir] = useState<'forward' | 'back'>('forward')
  const [nav, setNav] = useState<WizardNavState>({})
  const [busy, setBusy] = useState(false)
  const path = wiz?.path ?? null
  const skipped = wiz?.skipped ?? EMPTY
  const def = wizardStep(step) ?? wizardSteps[0]
  const ids = idsFor(path)
  const visible = useMemo(() => ids.map((id) => wizardStep(id)).filter((s): s is WizardStep => !!s), [ids])
  const index = Math.max(0, ids.indexOf(def.id))
  const mainRef = useRef<HTMLElement>(null)
  // An Edit link on the Summary returns there after that step instead of walking every later step again.
  const returnTo = useRef<string | null>(null)

  useEffect(() => {
    shownStep = def.id
    return () => {
      shownStep = null
    }
  }, [def.id])

  // Save the position on every move (07 D11: resume after a restart on the same step).
  useEffect(() => {
    if (useStore.getState().settings?.wizard.step !== def.id) setSetting('wizard.step', def.id, { immediate: true })
  }, [def.id])

  // A rerun link (?rerun=1) starts at Welcome and is consumed once: later reloads resume where the owner is.
  useEffect(() => {
    if (!rerun) return
    setStep('welcome')
    setDir('back')
    navigate('/setup', { replace: true })
  }, [rerun])

  const go = useCallback((id: string, d: 'forward' | 'back' = 'forward') => {
    setDir(d)
    setNav({})
    setStep(id)
    // New step: focus its heading for screen readers and keyboard users; scroll to the top.
    requestAnimationFrame(() => {
      mainRef.current?.scrollTo({ top: 0 })
      mainRef.current?.querySelector<HTMLElement>('h1, h2')?.focus({ preventScroll: true })
    })
  }, [])

  const next = useCallback(() => {
    const cur = useStore.getState().settings?.wizard
    const n = returnTo.current ?? nextStep(cur?.path ?? null, def.id)
    returnTo.current = null
    if (def.optional && cur?.skipped.includes(def.id)) setSetting('wizard.skipped', withoutSkipped(cur.skipped, def.id), { immediate: true })
    if (n) go(n)
  }, [def, go])

  const skip = useCallback(() => {
    const cur = useStore.getState().settings?.wizard
    setSetting('wizard.skipped', withSkipped(cur?.skipped ?? [], def.id), { immediate: true })
    const n = returnTo.current ?? nextStep(cur?.path ?? null, def.id)
    returnTo.current = null
    if (n) go(n)
  }, [def, go])

  const back = useCallback(() => {
    returnTo.current = null
    const p = prevStep(useStore.getState().settings?.wizard.path ?? null, def.id)
    if (p) go(p, 'back')
  }, [def, go])

  const onContinue = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (await continueStep(nav)) next()
    } finally {
      setBusy(false)
    }
  }

  const props: WizardStepProps = { onNext: next, onBack: back, onSkip: def.optional ? skip : undefined, onGoTo: (id) => {
      returnTo.current = def.id === 'summary' ? 'summary' : null
      go(id, ids.indexOf(id) < index ? 'back' : 'forward')
    } }
  const Page = pageFor(def)
  const guided = path === 'guided' && def.id !== 'welcome' && def.id !== 'finale'
  const showNav = !nav.hideNav && def.id !== 'welcome' && def.id !== 'finale'
  const stepNo = ids.indexOf(def.id)

  return (
    <div className={`wiz${guided ? ' wiz--rail' : ''}`} data-step={def.id}>
      <div className="wiz__sky" aria-hidden="true" />
      {guided ? <Rail steps={visible} current={def.id} skipped={skipped} index={index} onGo={(id) => go(id, ids.indexOf(id) < index ? 'back' : 'forward')} /> : null}
      <main className="wiz__main" ref={mainRef}>
        {def.id !== 'welcome' && def.id !== 'finale' ? (
          <div className="wiz__progress" aria-hidden={guided ? 'true' : undefined}>
            {ids.length - 2 > 1 ? (
              <>
                <span className="wiz__progress-text">
                  Step {stepNo} of {ids.length - 2}
                </span>
                <span className="wiz__progress-track">
                  <span className="wiz__progress-fill" style={{ width: `${(stepNo / (ids.length - 2)) * 100}%` }} />
                </span>
              </>
            ) : (
              // Quick start has a single working step: "Step 1 of 1" with a full bar read as already done (F56).
              <span className="wiz__progress-text">Quick start · one step, then you can chat</span>
            )}
          </div>
        ) : null}
        <div className={`wiz__card wiz__card--${def.id} wiz-in-${dir}`} key={def.id}>
          <WizardNavProvider set={setNav}>
            <Suspense
              fallback={
                <div className="page-fallback" data-suspense-fallback>
                  <Spinner size={20} label="Loading" />
                </div>
              }
            >
              <Page {...props} />
            </Suspense>
          </WizardNavProvider>
        </div>
        {showNav ? (
          <WizardNavBar nav={nav} busy={busy} canGoBack={index > 0} optional={!!def.optional} onBack={back} onSkip={skip} onContinue={() => void onContinue()} />
        ) : null}
        {def.optional ? <p className="wiz__later">You can change all of this later in Settings.</p> : null}
      </main>
    </div>
  )
}
const EMPTY: string[] = []

/** The guided path's progress rail: done ✓, skipped, current; earlier steps are links back. */
function Rail({ steps, current, skipped, index, onGo }: { steps: WizardStep[]; current: string; skipped: readonly string[]; index: number; onGo(id: string): void }): ReactNode {
  const shown = steps.filter((s) => s.id !== 'welcome' && s.id !== 'finale')
  return (
    <aside className="wiz__rail" aria-label="Setup progress">
      <div className="wiz__rail-head">
        <Star size={44} />
        <div>
          <p className="wiz__rail-title">Setting up Vesper</p>
          <DownloadChip />
        </div>
      </div>
      <ol className="wiz__steps">
        {shown.map((s) => {
          const i = steps.indexOf(s)
          const state = s.id === current ? 'current' : skipped.includes(s.id) && i < index ? 'skipped' : i < index ? 'done' : 'todo'
          const Icon = s.icon
          const body = (
            <>
              <span className={`wiz__dot wiz__dot--${state}`} aria-hidden="true">
                {state === 'done' ? <Check /> : <Icon />}
              </span>
              <span className="wiz__step-text">
                <span className="wiz__step-title">{s.title}</span>
                <span className="wiz__step-hint">{state === 'skipped' ? 'Skipped — finish later' : s.hint}</span>
              </span>
            </>
          )
          return (
            <li key={s.id} className={`wiz__step wiz__step--${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              {state === 'done' || state === 'skipped' ? (
                <button type="button" className="wiz__step-btn" onClick={() => onGo(s.id)} aria-label={`${s.title}: ${state === 'done' ? 'done' : 'skipped'}. Go back to this step`}>
                  {body}
                </button>
              ) : (
                <div className="wiz__step-btn">
                  {body}
                  {state === 'current' ? <span className="sr-only"> (current step)</span> : null}
                </div>
              )}
            </li>
          )
        })}
      </ol>
      <Button variant="ghost" size="sm" className="wiz__later-btn" onClick={() => navigate('/')}>
        Finish later
      </Button>
    </aside>
  )
}

/** Speech-model downloads keep running in the background (07 D11); the rail shows their progress. */
function DownloadChip(): ReactNode {
  const [p, setP] = useState<{ bytes: number; total: number; state: string } | null>(null)
  useEffect(
    () =>
      ws.on('stt.model.progress', (m) => {
        setP(m.state === 'ready' || m.state === 'error' ? (m.state === 'ready' ? { bytes: m.total, total: m.total, state: 'ready' } : null) : { bytes: m.bytes, total: m.total, state: m.state })
      }),
    []
  )
  // Step 1 (the AI service) cannot be skipped (07 D11), so "all optional" was untrue (F56).
  if (!p) return <p className="wiz__rail-sub">A few minutes · only the AI service is required</p>
  const pct = p.total ? Math.round((p.bytes / p.total) * 100) : 0
  return (
    <p className="wiz__rail-sub wiz__dl" role="status">
      <Download aria-hidden="true" />
      {p.state === 'ready' ? 'Speech model ready' : p.state === 'downloading' ? `Speech model ${pct} %` : 'Checking the speech model…'}
    </p>
  )
}
