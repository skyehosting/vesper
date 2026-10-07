/**
 * SecretInput (04; a.k.a. KeyField) — write-only entry for API keys and secret header values (07 B1/B2). The saved
 * key is never sent to the client, so the field can't show it: it shows a "Saved" state with Replace / Remove. While
 * typing, the value is masked (Reveal shows only what was just typed); pasting trims whitespace and newlines; Enter
 * saves. The browser is told not to store or autofill it.
 *
 *   <SecretInput label="ElevenLabs API key" saved={hasKey} onSave={(k) => api.putSecret('tts:elevenlabs', k)}
 *     onRemove={() => api.deleteSecret('tts:elevenlabs')} hint="Needs “Voices: read”." />
 */
import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import { Eye, EyeOff, KeyRound, Lock } from 'lucide-react'
import { Badge } from './Badge'
import { Button } from './Button'
import { Field } from './Field'
import { IconButton } from './IconButton'
import { ApiErrorException } from '../lib/errors.logic'
import { cx } from './internal/cx'
import './SecretInput.css'

export interface SecretInputProps {
  label: ReactNode
  /** A key is stored server-side (from settings' `secrets` presence flags). */
  saved: boolean
  /** Store the key; throw (e.g. ApiErrorException) to show an error and keep the typed value. */
  onSave: (value: string) => Promise<void> | void
  onRemove?: () => Promise<void> | void
  hint?: ReactNode
  /** An external error (e.g. "secret_unreadable" from bootstrap). */
  error?: ReactNode
  placeholder?: string
  /** Quick client-side check ("doesn't look like an ElevenLabs key"); return an error text or null. */
  validate?: (value: string) => string | null
  disabled?: boolean
  /** Text of the saved state (default "Saved"). Never the key itself. */
  savedText?: string
  id?: string
  className?: string
}

/** Pasted keys often carry a trailing newline or spaces from the provider's page. */
export function cleanSecret(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, '').trim()
}

export function SecretInput({
  label,
  saved,
  onSave,
  onRemove,
  hint,
  error: externalError,
  placeholder = 'Paste your key',
  validate,
  disabled = false,
  savedText = 'Saved',
  id,
  className
}: SecretInputProps): ReactNode {
  const [editing, setEditing] = useState(!saved)
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLButtonElement>(null)
  const focusInput = useRef(false)

  // Saved elsewhere (another device, the wizard): drop out of editing if the user hasn't typed anything.
  useEffect(() => {
    if (saved && value === '') setEditing(false)
    if (!saved) setEditing(true)
    // Only when the saved flag flips.
  }, [saved])

  useEffect(() => {
    if (editing && focusInput.current) {
      focusInput.current = false
      inputRef.current?.focus()
    }
  }, [editing])

  const save = async (): Promise<void> => {
    const v = cleanSecret(value)
    if (!v) {
      setError('Enter a key first.')
      return
    }
    const invalid = validate?.(v) ?? null
    if (invalid) {
      setError(invalid)
      return
    }
    setBusy('save')
    setError(null)
    try {
      await onSave(v)
      setValue('')
      setReveal(false)
      setEditing(false)
      requestAnimationFrame(() => replaceRef.current?.focus())
    } catch (e) {
      setError(e instanceof ApiErrorException ? e.error.message : "The key couldn't be saved.")
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (!onRemove) return
    setBusy('remove')
    setError(null)
    try {
      await onRemove()
    } catch (e) {
      setError(e instanceof ApiErrorException ? e.error.message : "The key couldn't be removed.")
    } finally {
      setBusy(null)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>): void => {
    const text = e.clipboardData.getData('text')
    const clean = cleanSecret(text)
    if (clean === text) return
    e.preventDefault()
    const el = e.currentTarget
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    setValue(value.slice(0, start) + clean + value.slice(end))
    setError(null)
  }

  const shownError = error ?? externalError

  return (
    <Field label={label} hint={hint} error={shownError || undefined} id={id} className={cx('secret', className)}>
      {(f) =>
        !editing ? (
          <div className="secret__saved">
            <div className="input is-readonly secret__mask" id={f.id} role="group" aria-labelledby={`${f.labelId} ${f.id}-state`} {...f.aria}>
              <Lock className="secret__lock" aria-hidden="true" />
              <span className="secret__dots" aria-hidden="true">
                ••••••••••••••••
              </span>
              <Badge tone="success" dot>
                <span id={`${f.id}-state`}>{savedText}</span>
              </Badge>
            </div>
            <div className="secret__actions">
              <Button
                ref={replaceRef}
                size="sm"
                disabled={disabled || busy !== null}
                onClick={() => {
                  focusInput.current = true
                  setEditing(true)
                }}
              >
                Replace
              </Button>
              {onRemove ? (
                <Button size="sm" variant="ghost" disabled={disabled} loading={busy === 'remove'} onClick={() => void remove()}>
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        ) : (
          // Not a <form>: settings pages may already be inside one, and forms can't nest. Enter saves instead.
          <div className="secret__edit">
            <div className={cx('input', disabled && 'is-disabled')}>
              <span className="input__affix" aria-hidden="true">
                <KeyRound />
              </span>
              <input
                ref={inputRef}
                id={f.id}
                className="input__control mono secret__input"
                type={reveal ? 'text' : 'password'}
                value={value}
                placeholder={placeholder}
                disabled={disabled || busy === 'save'}
                {...f.aria}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-1p-ignore=""
                data-lpignore="true"
                data-form-type="other"
                onPaste={onPaste}
                onChange={(e) => {
                  setValue(e.target.value)
                  if (error) setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void save()
                  } else if (e.key === 'Escape' && saved) {
                    e.stopPropagation()
                    setValue('')
                    setEditing(false)
                  }
                }}
              />
              {value ? (
                <IconButton
                  size="sm"
                  label={reveal ? 'Hide key' : 'Show the key you typed'}
                  icon={reveal ? <EyeOff /> : <Eye />}
                  pressed={reveal}
                  tooltip={false}
                  className="input__affix--end"
                  onClick={() => setReveal(!reveal)}
                />
              ) : null}
            </div>
            <div className="secret__actions">
              <Button size="sm" variant="primary" loading={busy === 'save'} disabled={disabled || !value.trim()} onClick={() => void save()}>
                Save
              </Button>
              {saved ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setValue('')
                    setError(null)
                    setEditing(false)
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        )
      }
    </Field>
  )
}
