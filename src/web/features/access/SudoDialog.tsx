/**
 * "Confirm it's you" (07 B2 sudo): asked when a device that is not the PC does something sensitive (revoke another
 * device, read the audit log, export) more than 10 minutes after it last entered the password. A successful answer
 * retries the original request (lib/api.ts); Cancel gives up and the caller shows its own error.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { TextField } from '../../components/TextField'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { readSignInError, secondsLeft } from '../login/login.logic'
import { resolveSudo } from './sudo'
import './access.css'

export default function SudoDialog(): ReactNode {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lockedUntil, setLockedUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!lockedUntil) return
    const h = window.setInterval(() => {
      setNow(Date.now())
      if (Date.now() >= lockedUntil) setLockedUntil(null)
    }, 500)
    return () => window.clearInterval(h)
  }, [lockedUntil])

  const wait = secondsLeft(lockedUntil, now)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!password || busy || wait > 0) return
    setBusy(true)
    setError(null)
    try {
      await api('POST /api/auth/sudo', { body: { password }, noSudoRetry: true })
      resolveSudo(true)
    } catch (err) {
      const p = readSignInError(toApiError(err), true)
      setError(p.message)
      if ((p.kind === 'wrong' || p.kind === 'locked' || p.kind === 'other') && p.retryAfterSec) setLockedUntil(Date.now() + p.retryAfterSec * 1000)
      setPassword('')
      input.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onClose={() => resolveSudo(false)}
      size="sm"
      title="Confirm it’s you"
      description="Enter your Vesper password to continue. You won’t be asked again for 10 minutes."
      initialFocus={input}
      footer={
        <>
          <Button variant="ghost" onClick={() => resolveSudo(false)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="vesper-sudo-form" loading={busy} disabled={!password || wait > 0} icon={<ShieldCheck />}>
            Continue
          </Button>
        </>
      }
    >
      <form id="vesper-sudo-form" className="acc-sudo" onSubmit={(e) => void submit(e)} noValidate>
        <TextField
          ref={input}
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
        />
        {wait > 0 ? (
          <p className="acc-muted" role="status">
            Try again in {wait} s.
          </p>
        ) : null}
      </form>
    </Dialog>
  )
}
