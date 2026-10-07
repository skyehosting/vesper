/**
 * ErrorState (07 C19/D13) — a failure shown in place of content, driven by the shared error catalogue: the message is
 * the catalogue's (never an upstream body), and the action button follows the code's UI action (Retry, Fix in
 * Settings, Sign in, Get a speech model, Open Windows settings). Rate limits count down `retryAfter`.
 *
 *   <ErrorState error={err} onRetry={reload} />            // err: ApiErrorException | ApiError | ErrorCode | Error
 *   <ErrorState compact error="network" onRetry={reload} />
 */
import { useEffect, useState, type ReactNode } from 'react'
import { CircleAlert, KeyRound, RotateCcw, Settings, WifiOff } from 'lucide-react'
import { apiError, ERRORS, type ApiError, type ErrorAction, type ErrorCode } from '@shared/errors'
import { ApiErrorException, isErrorCode } from '../lib/errors.logic'
import { navigate } from '../lib/router'
import { Button } from './Button'
import { cx } from './internal/cx'
import { track } from './internal/stats'
import './ErrorState.css'

export type ErrorLike = ApiError | ApiErrorException | ErrorCode | Error | string | null | undefined

/** Normalise anything thrown into the shared ApiError (unknown errors → `internal`, message from the catalogue). */
export function toApiError(e: ErrorLike): ApiError {
  if (e instanceof ApiErrorException) return e.error
  if (typeof e === 'string') return apiError(isErrorCode(e) ? e : 'internal')
  if (e && typeof e === 'object' && 'code' in e && isErrorCode((e as { code: unknown }).code)) {
    const a = e as ApiError
    return { ...apiError(a.code), ...a, message: a.message || ERRORS[a.code].message }
  }
  if (e instanceof TypeError) return apiError('network')
  return apiError('internal')
}

const TITLES: Partial<Record<ErrorCode, string>> = {
  network: "Can't connect",
  unauthorized: 'Signed out',
  provider_auth: 'API key rejected',
  provider_quota: 'Out of credit',
  not_found: 'Not found',
  rate_limited: 'Slow down a little',
  provider_rate: 'Busy for a moment',
  provider_overloaded: 'AI service busy',
  provider_error: 'AI service error',
  provider_empty: 'Empty reply',
  provider_bad_request: 'Request not accepted',
  provider_not_found: 'Model not found',
  provider_context: 'Conversation too long',
  provider_refusal: 'No answer',
  db_error: 'Database problem',
  disk_full: 'Disk almost full',
  not_implemented: 'Not available yet'
}

export interface ErrorStateProps {
  error: ErrorLike
  /** Heading; defaults per code ("Can't connect", "API key rejected", …) else "Something went wrong". */
  title?: ReactNode
  onRetry?: () => void
  /** Override the catalogue action (e.g. open a settings sheet instead of navigating). */
  onAction?: (action: ErrorAction) => void
  compact?: boolean
  className?: string
}

function actionLabel(a: ErrorAction): string | null {
  switch (a.kind) {
    case 'settings':
      return 'Fix in Settings'
    case 'login':
      return 'Sign in'
    case 'download-model':
      return 'Get a speech model'
    case 'open-uri':
      return 'Open Windows settings'
    default:
      return null
  }
}

function runAction(a: ErrorAction): void {
  if (a.kind === 'settings') navigate(`/settings/${a.section}`)
  else if (a.kind === 'login') navigate('/login')
  else if (a.kind === 'download-model') navigate('/settings/voice-in')
  else if (a.kind === 'open-uri') void window.vesperDesktop?.openExternal?.(a.uri)
}

function useCountdown(seconds: number | undefined): number {
  const [left, setLeft] = useState(seconds ?? 0)
  useEffect(() => {
    setLeft(seconds ?? 0)
    if (!seconds || seconds <= 0) return
    const end = Date.now() + seconds * 1000
    const h = window.setInterval(() => {
      const s = Math.max(0, Math.ceil((end - Date.now()) / 1000))
      setLeft(s)
      if (s === 0) window.clearInterval(h)
    }, 250)
    track('kit.timers', 1)
    return () => {
      window.clearInterval(h)
      track('kit.timers', -1)
    }
  }, [seconds])
  return left
}

export function ErrorState({ error, title, onRetry, onAction, compact = false, className }: ErrorStateProps): ReactNode {
  const e = toApiError(error)
  const info = ERRORS[e.code]
  const left = useCountdown(e.retryAfter)
  const label = actionLabel(info.action)
  const desktopOnlyUri = info.action.kind === 'open-uri' && !window.vesperDesktop?.openExternal
  const icon = e.code === 'network' ? <WifiOff /> : e.code === 'provider_auth' || e.code === 'key_missing' ? <KeyRound /> : <CircleAlert />
  const heading = title ?? TITLES[e.code] ?? 'Something went wrong'
  const canRetry = !!onRetry && (info.retryable || info.action.kind === 'retry')

  return (
    <div className={cx('error-state', compact && 'error-state--compact', className)} role="alert" data-error-code={e.code}>
      <span className="error-state__icon" aria-hidden="true">
        {icon}
      </span>
      <div className="error-state__text">
        <p className="error-state__title">{heading}</p>
        <p className="error-state__message">{e.message}</p>
      </div>
      {canRetry || (label && !desktopOnlyUri) ? (
        <div className="error-state__actions">
          {label && !desktopOnlyUri ? (
            <Button size={compact ? 'sm' : 'md'} variant={canRetry ? 'secondary' : 'primary'} icon={<Settings />} onClick={() => (onAction ? onAction(info.action) : runAction(info.action))}>
              {label}
            </Button>
          ) : null}
          {canRetry ? (
            <Button size={compact ? 'sm' : 'md'} variant="primary" icon={<RotateCcw />} disabled={left > 0} onClick={onRetry}>
              {left > 0 ? `Try again in ${left} s` : 'Try again'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
