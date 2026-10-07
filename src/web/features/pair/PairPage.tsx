/**
 * '/pair#c=<code>' — join with a one-time pairing code (07 B16, research 06 §5.7). The code lives in the URL
 * fragment, which browsers never send to the server or put in Referer; it is read once, then wiped from the address
 * bar and history, and only ever leaves in the POST body of `/api/auth/pair/redeem`.
 *  - Codes from "Open in browser" on this PC (vesper.localhost) are redeemed at once and need no approval.
 *  - Phone codes (LAN / Tailscale) first ask for a device name, then wait for the PC to allow the device.
 * Public route: rendered before sign-in. A browser that is already signed in just goes home.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowRight, Link2Off, LogIn, QrCode, TimerReset } from 'lucide-react'
import { Button } from '../../components/Button'
import { Spinner } from '../../components/Spinner'
import { TextField } from '../../components/TextField'
import { boot } from '../../app/boot'
import type { PageProps } from '../../app/routes'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { AuthLayout } from '../login/AuthLayout'
import { guessDeviceName, isThisPcHost, pairCodeFromHash, readSignInError, secondsLeft } from '../login/login.logic'
import { PendingApproval } from '../login/PendingApproval'

type View = { kind: 'confirm' } | { kind: 'redeeming' } | { kind: 'pending'; name: string } | { kind: 'invalid' } | { kind: 'missing' } | { kind: 'error'; message: string; until: number | null }

/** Read once per page load: the fragment is wiped right after (a re-render must not lose the code). */
let initialCode: string | null | undefined

function takeCode(): string | null {
  const fresh = pairCodeFromHash(location.hash)
  if (fresh) initialCode = fresh
  return initialCode ?? null
}

export default function PairPage(_props: PageProps): ReactNode {
  const phase = useStore((s) => s.phase)
  const [code, setCode] = useState(takeCode)
  const local = isThisPcHost(location.hostname)
  const [view, setView] = useState<View>(() => (!code ? { kind: 'missing' } : local ? { kind: 'redeeming' } : { kind: 'confirm' }))
  const [name, setName] = useState(() => guessDeviceName(navigator.userAgent))
  const [now, setNow] = useState(() => Date.now())
  const started = useRef(false)

  // Wipe the code from the address bar and the history entry (it is single-use, but still a secret until used).
  useLayoutEffect(() => {
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search)
  }, [])

  // Scanning a new code while this page is open only changes the fragment (no reload): take the new code.
  useEffect(() => {
    const onHash = (): void => {
      const fresh = pairCodeFromHash(location.hash)
      history.replaceState(history.state, '', location.pathname + location.search)
      if (!fresh) return
      initialCode = fresh
      setCode(fresh)
      setView({ kind: 'confirm' })
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Already signed in on this browser: nothing to pair.
  useEffect(() => {
    if (phase === 'ready') navigate('/', { replace: true })
  }, [phase])

  const redeem = async (deviceName: string): Promise<void> => {
    if (!code) return
    setView({ kind: 'redeeming' })
    try {
      const r = await api('POST /api/auth/pair/redeem', { body: { code, deviceName } })
      // The code is spent either way from here on.
      initialCode = null
      if (r.pending) {
        setView({ kind: 'pending', name: deviceName })
        return
      }
      await boot()
    } catch (e) {
      const err = toApiError(e)
      if (err.code === 'unauthorized') {
        initialCode = null
        setView({ kind: 'invalid' })
        return
      }
      const p = readSignInError(err, true)
      const until = 'retryAfterSec' in p && p.retryAfterSec ? Date.now() + p.retryAfterSec * 1000 : null
      setView({ kind: 'error', message: p.kind === 'locked' ? 'Too many attempts.' : p.message, until })
    }
  }

  // "Open in browser" on this PC: no questions, no approval. Once per page load.
  useEffect(() => {
    if (!local || !code || started.current || phase === 'ready') return
    started.current = true
    void redeem(guessDeviceName(navigator.userAgent))
  }, [])

  const until = view.kind === 'error' ? view.until : null
  useEffect(() => {
    if (!until) return
    const h = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(h)
  }, [until])

  if (phase === 'ready') return <div data-loading hidden />

  const toLogin = (): void => navigate('/login', { replace: true })

  switch (view.kind) {
    case 'pending':
      return <PendingApproval deviceName={view.name} onUsePassword={useStore.getState().authState?.passwordSet ? toLogin : undefined} onStartOver={() => setView({ kind: 'invalid' })} />
    case 'redeeming':
      return (
        <AuthLayout title="Pairing…" lead="Connecting this device to Vesper." busy>
          <Spinner size={22} label="Pairing" />
        </AuthLayout>
      )
    case 'missing':
      return (
        <AuthLayout
          glyph={
            <span className="login__badge">
              <Link2Off />
            </span>
          }
          title="This pairing link is incomplete"
          lead="Open the link again, or scan the code shown in Vesper on your PC (Settings → Access & security → Pair a device)."
        >
          <div className="login__actions">
            <Button variant="primary" size="lg" block icon={<LogIn />} onClick={toLogin}>
              Sign in with the password
            </Button>
          </div>
        </AuthLayout>
      )
    case 'invalid':
      return (
        <AuthLayout
          glyph={
            <span className="login__badge">
              <TimerReset />
            </span>
          }
          title="This code can’t be used"
          lead="Pairing codes work once and expire after 5 minutes. On your PC, choose Pair a device again and scan the new code."
        >
          <div className="login__actions">
            <Button variant="secondary" size="lg" block icon={<LogIn />} onClick={toLogin}>
              Sign in with the password
            </Button>
          </div>
        </AuthLayout>
      )
    case 'error': {
      const wait = secondsLeft(view.until, now)
      return (
        <AuthLayout title="Pairing didn’t work" lead={view.message}>
          <div className="login__actions">
            {wait > 0 ? (
              <p className="login__hint" role="status">
                Try again in {wait} s.
              </p>
            ) : null}
            <Button variant="primary" size="lg" block disabled={wait > 0} onClick={() => setView({ kind: 'confirm' })}>
              Try again
            </Button>
          </div>
        </AuthLayout>
      )
    }
    case 'confirm':
      return <ConfirmPair name={name} setName={setName} onPair={(n) => void redeem(n)} />
  }
}

function ConfirmPair({ name, setName, onPair }: { name: string; setName: (n: string) => void; onPair: (name: string) => void }): ReactNode {
  const submit = (e: FormEvent): void => {
    e.preventDefault()
    onPair(name.trim() || guessDeviceName(navigator.userAgent))
  }
  return (
    <AuthLayout
      glyph={
        <span className="login__badge">
          <QrCode />
        </span>
      }
      title="Pair this device with Vesper"
      lead="After you continue, Vesper on your PC asks whether to allow this device."
    >
      <form className="login__form" onSubmit={submit} noValidate>
        <TextField label="Name for this device" hint="Shown on your PC so you know which device is asking." value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
        <Button type="submit" variant="primary" size="lg" block iconRight={<ArrowRight />}>
          Pair this device
        </Button>
      </form>
    </AuthLayout>
  )
}
