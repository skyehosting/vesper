/**
 * '/login' — sign in from a browser (R1; 07 B15/B16, D8 phone-first). States:
 *  - the form: password + a device name (shown in the PC's device list); wrong password, the lockout countdown
 *    (429 / `retryAfter`, or the global ladder's `lockedUntilUtc`) and "can't reach Vesper";
 *  - suspended: after too many wrong passwords, password sign-in from other devices is off until the PC resumes it;
 *  - no password yet: explain pairing from the PC;
 *  - waiting for approval: this browser redeemed a pairing code and the PC must allow it (PendingApproval);
 *  - first visit: what Vesper is and that the owner approves new devices (expanded once, then a disclosure).
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { KeyRound, LogIn, QrCode, ShieldAlert, WifiOff } from 'lucide-react'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { Disclosure } from '../../components/Disclosure'
import { ProgressRing } from '../../components/Progress'
import { TextField } from '../../components/TextField'
import { signIn } from '../../app/boot'
import type { PageProps } from '../../app/routes'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { AuthLayout } from './AuthLayout'
import { guessDeviceName, readSignInError, secondsLeft, type SignInProblem } from './login.logic'
import { PendingApproval } from './PendingApproval'

const SEEN_KEY = 'vesper.login.introSeen'
/** The global ladder's wait never exceeds 60 s; clamp so a phone with a skewed clock can't show minutes. */
const MAX_LADDER_MS = 60_000

function readSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

/** Read once per page load, so re-mounts (sign-in errors, state changes) don't fold the intro away mid-visit. */
let firstVisitCache: boolean | null = null
function isFirstVisit(): boolean {
  firstVisitCache ??= !readSeen()
  return firstVisitCache
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // private mode / blocked storage: the intro just shows again next time
  }
}

export default function LoginPage(_props: PageProps): ReactNode {
  const auth = useStore((s) => s.authState)
  const [usePassword, setUsePassword] = useState(false)

  if (auth?.pendingApproval && !usePassword) {
    return <PendingApproval onUsePassword={auth.passwordSet ? () => setUsePassword(true) : undefined} onStartOver={auth.passwordSet ? undefined : () => location.reload()} />
  }
  return <LoginForm />
}

function LoginForm(): ReactNode {
  const auth = useStore((s) => s.authState)
  const [password, setPassword] = useState('')
  const [deviceName, setDeviceName] = useState(() => guessDeviceName(navigator.userAgent))
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<SignInProblem | null>(null)
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [lockTotal, setLockTotal] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [firstVisit] = useState(isFirstVisit)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    markSeen()
  }, [])

  // The server's global ladder (07 B15) arrives in /api/auth/state.
  useEffect(() => {
    const until = auth?.lockedUntilUtc ?? null
    if (!until) return
    const ms = Math.min(MAX_LADDER_MS, until - Date.now())
    if (ms > 0) startLock(ms)
  }, [auth?.lockedUntilUtc])

  useEffect(() => {
    if (!lockedUntil) return
    const h = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= lockedUntil) {
        setLockedUntil(null)
        passwordRef.current?.focus()
      }
    }, 250)
    return () => window.clearInterval(h)
  }, [lockedUntil])

  function startLock(ms: number): void {
    const t = Date.now()
    setNow(t)
    setLockedUntil(t + ms)
    setLockTotal(ms)
  }

  const lockSecs = secondsLeft(lockedUntil, now)
  const suspended = problem?.kind === 'suspended'

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!password || busy || lockSecs > 0 || suspended) return
    setBusy(true)
    setProblem(null)
    try {
      await signIn(password, deviceName.trim() || guessDeviceName(navigator.userAgent))
    } catch (err) {
      const p = readSignInError(toApiError(err), auth?.passwordSet ?? true)
      setProblem(p.kind === 'locked' ? null : p)
      if ((p.kind === 'wrong' || p.kind === 'locked' || p.kind === 'other') && p.retryAfterSec) startLock(p.retryAfterSec * 1000)
      setPassword('')
      // Keep focus in the field for the next try (it's disabled while locked; the timer refocuses it).
      window.setTimeout(() => passwordRef.current?.focus(), 0)
    } finally {
      setBusy(false)
    }
  }

  const noPassword = auth !== null && !auth.passwordSet

  return (
    <AuthLayout
      title="Sign in to Vesper"
      lead={noPassword ? undefined : 'Vesper is running on your PC. Sign in to use it on this device.'}
      footer={<AboutVesper open={firstVisit} />}
    >
      {noPassword ? (
        <div className="login__stack">
          <Callout tone="info" icon={<QrCode />} title="Pair this device from your PC">
            No password is set yet, so this device has to be paired. On your PC, open Vesper → <b>Settings → Access &amp; security</b> and choose <b>Pair a device</b>, then scan the code
            with this device.
          </Callout>
          <p className="login__hint">You can also set a password there and sign in with it here.</p>
        </div>
      ) : (
        <form className="login__form" onSubmit={(e) => void submit(e)} noValidate>
          {suspended ? (
            <Callout tone="danger" icon={<ShieldAlert />} title="Sign-in from other devices is paused">
              {problem.message} You can still pair this device from the PC.
            </Callout>
          ) : null}
          <TextField
            ref={passwordRef}
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={suspended}
            error={problem && (problem.kind === 'wrong' || problem.kind === 'other' || problem.kind === 'no-password') ? <span role="alert">{problem.message}</span> : undefined}
          />
          <TextField
            label="Name for this device"
            hint="Shown in the device list on your PC."
            value={deviceName}
            maxLength={60}
            autoComplete="off"
            onChange={(e) => setDeviceName(e.target.value)}
            disabled={suspended}
          />
          {problem?.kind === 'network' ? (
            <p className="login__problem" role="alert">
              <WifiOff aria-hidden="true" />
              {problem.message}
            </p>
          ) : null}
          {lockSecs > 0 ? (
            <div className="login__lock">
              <ProgressRing value={lockTotal > 0 ? (lockSecs * 1000) / lockTotal : 0} size={28} thickness={3} label="Time until you can try again" tone="warning" />
              <p role="status">Too many attempts. Try again in {lockSecs} s.</p>
            </div>
          ) : null}
          <Button type="submit" variant="primary" size="lg" block icon={<LogIn />} loading={busy} disabled={!password || lockSecs > 0 || suspended}>
            Sign in
          </Button>
          {suspended ? (
            <Button variant="ghost" block icon={<KeyRound />} onClick={() => setProblem(null)}>
              Try again
            </Button>
          ) : null}
        </form>
      )}
    </AuthLayout>
  )
}

/** First visit: what Vesper is and how getting in works (07 B16). Expanded once, then folded away. */
function AboutVesper({ open }: { open: boolean }): ReactNode {
  return (
    <Disclosure summary="What is Vesper?" defaultOpen={open} className="login__about">
      <ul className="login__facts">
        <li>Vesper is a personal AI companion that runs on its owner’s PC. Chats are stored on that PC.</li>
        <li>
          To use it here, sign in with the Vesper password, or pair this device: on the PC, open <b>Settings → Access &amp; security → Pair a device</b> and scan the code.
        </li>
        <li>New paired devices only get in after the owner allows them on the PC.</li>
      </ul>
    </Disclosure>
  )
}
