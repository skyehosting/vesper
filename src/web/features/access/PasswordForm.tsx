/**
 * Set or change Vesper's password (07 B15): 15–1024 characters, not a common password, not a simple pattern — the
 * rules are checked live while typing (password.logic.ts mirrors the server). On the PC no current password is
 * needed; elsewhere it is. Changing it signs every other device out (the PC's own window stays signed in).
 */
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { Check, Circle, KeyRound } from 'lucide-react'
import { Button } from '../../components/Button'
import { TextField } from '../../components/TextField'
import { toApiError } from '../../lib/errors.logic'
import { setPassword } from './data'
import { checkPassword, PASSWORD_MIN } from './password.logic'

export function PasswordForm({
  isSet,
  desktop,
  onSaved,
  submitLabel
}: {
  isSet: boolean
  desktop: boolean
  onSaved?: () => void
  submitLabel?: string
}): ReactNode {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<{ current?: string; next?: string; form?: string }>({})
  const [touched, setTouched] = useState(false)
  const check = useMemo(() => checkPassword(next), [next])
  const needCurrent = isSet && !desktop
  const mismatch = confirm.length > 0 && confirm !== next
  const ready = !check.problem && confirm === next && (!needCurrent || current.length > 0)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setTouched(true)
    if (!ready || busy) return
    setBusy(true)
    setErrors({})
    try {
      await setPassword(needCurrent ? { current, next } : { next })
      setCurrent('')
      setNext('')
      setConfirm('')
      setTouched(false)
      onSaved?.()
    } catch (err) {
      const a = toApiError(err)
      setErrors({ current: a.fields?.current, next: a.fields?.next, form: a.fields ? undefined : a.message })
    } finally {
      setBusy(false)
    }
  }

  const rule = (ok: boolean, text: string): ReactNode => (
    <li className={ok ? 'is-ok' : undefined}>
      {ok ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
      <span>{text}</span>
      <span className="sr-only">{ok ? ' (done)' : ' (not yet)'}</span>
    </li>
  )

  return (
    <form className="acc-pw" onSubmit={(e) => void submit(e)} noValidate>
      {needCurrent ? (
        <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={errors.current} />
      ) : null}
      <TextField
        label={isSet ? 'New password' : 'Password'}
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        error={errors.next ?? (touched && check.problem ? check.problem : undefined)}
        trailing={
          next ? (
            <span className={check.longEnough ? 'acc-pw__count is-ok' : 'acc-pw__count'} aria-hidden="true">
              {check.chars}
            </span>
          ) : undefined
        }
      />
      <ul className="acc-pw__rules" aria-label="Password rules">
        {rule(check.longEnough && check.notTooLong, `At least ${PASSWORD_MIN} characters — a few words with spaces work well`)}
        {rule(next.length > 0 && check.notCommon, 'Not a commonly used password')}
        {rule(next.length > 0 && check.notPattern && check.noControl, 'Not a simple pattern like repeats or keyboard runs')}
      </ul>
      <TextField
        label="Repeat the password"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={mismatch || (touched && confirm !== next) ? 'The two passwords are different.' : undefined}
      />
      {errors.form ? (
        <p className="acc-error" role="alert">
          {errors.form}
        </p>
      ) : null}
      <div className="acc-pw__foot">
        {isSet ? <p className="acc-muted">Changing it signs out every other device{desktop ? '' : ' except this one'}.</p> : <span />}
        <Button type="submit" variant="primary" icon={<KeyRound />} loading={busy} disabled={!ready}>
          {submitLabel ?? (isSet ? 'Change password' : 'Set password')}
        </Button>
      </div>
    </form>
  )
}
