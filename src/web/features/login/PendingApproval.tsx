/**
 * "Waiting for your PC" (07 B16): this device redeemed a pairing code and the desktop has to allow it. Polls the
 * public `GET /api/auth/state` every 2 s (slower while the tab is hidden) until it reports `signedIn` (→ boot into
 * the app) or neither signed in nor pending (denied, or expired after 10 minutes on the server). One timer, one
 * in-flight request, both released on unmount.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { KeyRound, RotateCcw, ShieldX } from 'lucide-react'
import { Button } from '../../components/Button'
import { boot } from '../../app/boot'
import { api } from '../../lib/api'
import { useStore } from '../../lib/store'
import { registerTestHooks } from '../../lib/testHooks'
import { formatCountdown } from '../access/access.logic'
import { AuthLayout } from './AuthLayout'
import { PENDING_TTL_MS } from './login.logic'

const POLL_MS = 2000
const POLL_HIDDEN_MS = 6000

let livePollers = 0
/** Leak checks: pollers currently mounted. */
export function pendingPollers(): number {
  return livePollers
}
if (__VESPER_TEST__) registerTestHooks('access', { pendingPollers })

export function PendingApproval({
  deviceName,
  onUsePassword,
  onStartOver
}: {
  deviceName?: string
  /** Offer "Sign in with the password instead" (only when a password exists). */
  onUsePassword?: () => void
  /** After a denial: what "Try again" does (pairing: ask for a new code; login: back to the form). */
  onStartOver?: () => void
}): ReactNode {
  const [state, setState] = useState<'waiting' | 'denied' | 'offline'>('waiting')
  const [since] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    livePollers++
    let timer: number | null = null
    let ctrl: AbortController | null = null
    let stopped = false

    const schedule = (): void => {
      if (stopped) return
      timer = window.setTimeout(() => void poll(), document.visibilityState === 'hidden' ? POLL_HIDDEN_MS : POLL_MS)
    }
    const poll = async (): Promise<void> => {
      timer = null
      ctrl = new AbortController()
      try {
        const a = await api('GET /api/auth/state', { signal: ctrl.signal })
        if (stopped) return
        useStore.getState().setAuthState(a)
        if (a.signedIn) {
          stopped = true
          await boot()
          return
        }
        if (!a.pendingApproval) {
          setState('denied')
          stopped = true
          return
        }
        setState('waiting')
      } catch (e) {
        if (stopped || (e instanceof DOMException && e.name === 'AbortError')) return
        setState('offline')
      } finally {
        ctrl = null
      }
      schedule()
    }
    const onVisible = (): void => {
      // Coming back to the tab: check right away instead of waiting out the slow interval.
      if (document.visibilityState === 'visible' && timer !== null && !stopped) {
        window.clearTimeout(timer)
        void poll()
      }
    }
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    document.addEventListener('visibilitychange', onVisible)
    schedule()
    return () => {
      stopped = true
      livePollers--
      if (timer !== null) window.clearTimeout(timer)
      ctrl?.abort()
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (state === 'denied') {
    return (
      <AuthLayout
        glyph={
          <span className="login__badge login__badge--danger">
            <ShieldX />
          </span>
        }
        title="This device wasn’t allowed"
        lead="The PC denied the request, or nobody answered within 10 minutes."
      >
        <div className="login__actions">
          {onStartOver ? (
            <Button variant="primary" size="lg" block icon={<RotateCcw />} onClick={onStartOver}>
              Try again
            </Button>
          ) : null}
          {onUsePassword ? (
            <Button variant={onStartOver ? 'ghost' : 'primary'} size="lg" block icon={<KeyRound />} onClick={onUsePassword}>
              Sign in with the password
            </Button>
          ) : null}
        </div>
      </AuthLayout>
    )
  }

  const left = since + PENDING_TTL_MS - now
  return (
    <AuthLayout
      glyph="waiting"
      busy
      title="Waiting for your PC"
      lead={
        <>
          Vesper on your PC is asking whether to pair <b>{deviceName || 'this device'}</b>. Choose <b>Allow</b> there and this page continues by itself.
        </>
      }
    >
      <div className="login__wait" role="status" aria-live="polite">
        {state === 'offline' ? (
          <span>Can’t reach Vesper right now. Still trying…</span>
        ) : (
          <span>
            The request expires in <span className="login__mono">{formatCountdown(left)}</span>
          </span>
        )}
      </div>
      {onUsePassword ? (
        <Button variant="ghost" block icon={<KeyRound />} onClick={onUsePassword}>
          Sign in with the password instead
        </Button>
      ) : null}
    </AuthLayout>
  )
}
