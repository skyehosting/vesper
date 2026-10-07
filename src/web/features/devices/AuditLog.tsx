/**
 * Activity log (07 B2 sudo, research 06 §5.7): sign-ins, wrong passwords, pairing, approvals, revocations, password
 * and access changes — newest first, from `GET /api/auth/log` (the last 100). Loaded only when opened; off the PC it
 * asks for the password first (sudo). Entries are shown in words; raw JSON details never reach the screen.
 */
import { useCallback, useState, type ReactNode } from 'react'
import { History, RefreshCw } from 'lucide-react'
import type { EndpointRes } from '@shared/api'
import { Button } from '../../components/Button'
import { Disclosure } from '../../components/Disclosure'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Skeleton } from '../../components/Skeleton'
import { toApiError } from '../../lib/errors.logic'
import { useStore } from '../../lib/store'
import { auditDetail, auditLabel, auditTone } from '../access/access.logic'
import { loadAuthLog } from '../access/data'
import './devices.css'

type Entry = EndpointRes<'GET /api/auth/log'>[number]

export function AuditLog(): ReactNode {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState<ReturnType<typeof toApiError> | null>(null)
  const [busy, setBusy] = useState(false)
  const clock = useStore((s) => s.settings?.profile.clock ?? '24h')

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setEntries(await loadAuthLog())
    } catch (e) {
      setError(toApiError(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const toggle = (o: boolean): void => {
    setOpen(o)
    if (o && !entries && !busy) void load()
  }

  const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: clock === '12h' })

  return (
    <Disclosure summary="Activity log" meta={entries ? `${entries.length} entries` : undefined} variant="card" open={open} onOpenChange={toggle}>
      {error ? (
        <ErrorState error={error} compact title={error.code === 'sudo_required' ? 'Confirm your password to see the log' : undefined} onRetry={() => void load()} />
      ) : !entries ? (
        <div className="dev-skel" aria-hidden="true">
          <Skeleton variant="text" lines={4} />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState size="sm" headingLevel={3} icon={<History />} title="Nothing yet" description="Sign-ins, pairings and changes to access show up here." />
      ) : (
        <>
          <ol className="dev-log" aria-label="Activity, newest first">
            {entries.map((e, i) => {
              const detail = auditDetail(e.detail)
              return (
                <li key={`${e.tsUtc}-${i}`} className={`dev-log__row dev-log__row--${auditTone(e.event)}`}>
                  <span className="dev-log__dot" aria-hidden="true" />
                  <time className="dev-log__time" dateTime={new Date(e.tsUtc).toISOString()}>
                    {fmt.format(e.tsUtc)}
                  </time>
                  <span className="dev-log__what">
                    <span className="dev-log__event">{auditLabel(e.event)}</span>
                    {detail || e.ip ? <span className="dev-log__detail">{[detail, e.ip].filter(Boolean).join(' · ')}</span> : null}
                  </span>
                </li>
              )
            })}
          </ol>
          <div className="dev-log__foot">
            <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={busy} onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        </>
      )}
    </Disclosure>
  )
}
