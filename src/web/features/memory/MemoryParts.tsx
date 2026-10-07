/**
 * Pieces of Settings → Memory shared with the wizard: the scope choice (R8), the live status panel (07 C11
 * `memory.status` via `memory.progress`) and the backfill consent dialog (07 C12).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link2, Globe2, MessageSquare } from 'lucide-react'
import type { MemoryStatus, SessionSummary } from '@shared/types/domain'
import { Badge } from '../../components/Badge'
import { Callout } from '../../components/Callout'
import { Checkbox } from '../../components/Checkbox'
import { Dialog } from '../../components/Dialog'
import { Button } from '../../components/Button'
import { ProgressBar } from '../../components/Progress'
import { RadioGroup } from '../../components/RadioGroup'
import { Skeleton } from '../../components/Skeleton'
import { StatusDot } from '../../components/StatusDot'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { Stats } from './layout'
import { formatCount, formatDuration, plural } from './format.logic'
import { FREE_TRIAL_RPM, TIER1_RPM, TIER_LABELS } from './voyage.logic'
import { backfillDetail, backfillQuestion, statusText, type BackfillEstimate } from './MemoryParts.logic'

export { backfillDetail, backfillQuestion, statusText, type BackfillEstimate }

// ── scope ─────────────────────────────────────────────────────────────────────────────────────
export type ScopeValue = 'linked' | 'all' | 'this'

export const SCOPE_OPTIONS = [
  {
    value: 'linked' as const,
    label: 'This chat and the chats you link to it',
    description: 'Each chat remembers its own past and only the chats you choose to link. Nothing crosses between unrelated chats.',
    icon: <Link2 />,
    badge: <Badge tone="accent">Recommended</Badge>
  },
  {
    value: 'all' as const,
    label: 'Every chat',
    description: 'Any chat can recall any other, except private ones. Handy, but an old topic may come up anywhere.',
    icon: <Globe2 />
  },
  {
    value: 'this' as const,
    label: 'Only the chat itself',
    description: 'Each chat remembers only its own past, even when linked.',
    icon: <MessageSquare />
  }
]

export function ScopeChoice({ value, onChange, disabled }: { value: ScopeValue; onChange: (v: ScopeValue) => void; disabled?: boolean }): ReactNode {
  return (
    <RadioGroup
      label="What a chat can remember"
      labelHidden
      variant="cards"
      value={value}
      onChange={onChange}
      disabled={disabled}
      options={SCOPE_OPTIONS}
      name="memory-scope"
    />
  )
}

// ── status ────────────────────────────────────────────────────────────────────────────────────
export function StatusLine({ status }: { status: MemoryStatus | null }): ReactNode {
  const t = statusText(status)
  return (
    <span className="mstatus" data-testid="memory-state" data-state={status?.state ?? 'unknown'}>
      <StatusDot status={t.dot} label={t.text} pulse={t.dot === 'busy'} />
      <span>{t.text}</span>
    </span>
  )
}

export function StatusPanel({ status }: { status: MemoryStatus | null }): ReactNode {
  if (!status) return <Skeleton variant="rect" height={64} />
  const limit =
    status.tier === 'free' ? FREE_TRIAL_RPM : status.tier === 'unknown' ? null : TIER1_RPM * (status.tier === 'tier2' ? 2 : status.tier === 'tier3' ? 3 : 1)
  const items = [
    { label: 'Remembered', value: formatCount(status.indexed), hint: 'Messages with search vectors' },
    { label: 'Waiting', value: formatCount(status.queued), tone: status.queued > 0 ? ('warning' as const) : undefined },
    { label: 'Errors', value: formatCount(status.errors), tone: status.errors > 0 ? ('danger' as const) : undefined },
    { label: 'Voyage plan', value: TIER_LABELS[status.tier] },
    { label: 'Requests / min', value: limit ? `${status.rpmUsed ?? 0} of ${formatCount(limit)}` : String(status.rpmUsed ?? 0) },
    { label: 'Time left', value: status.queued > 0 ? formatDuration(status.queueEtaSec).replace('about ', '~') : '—' }
  ]
  return (
    <div className="mstatus-panel">
      <Stats items={items} label="Memory status" />
      {status.reindex ? (
        <ProgressBar
          label="Rebuilding the index"
          value={status.reindex.total ? status.reindex.done / status.reindex.total : undefined}
          valueText={`${formatCount(status.reindex.done)} of ${formatCount(status.reindex.total)}`}
        />
      ) : null}
      {status.lastError && (status.state === 'error' || status.state === 'degraded') ? (
        <Callout tone={status.state === 'error' ? 'danger' : 'warning'} title={status.state === 'error' ? 'Memory isn’t working' : 'Memory is having trouble'}>
          {status.lastError.message}
        </Callout>
      ) : null}
      {status.tier === 'free' ? (
        <Callout tone="info" title="The free trial is slow">
          Without a payment method Voyage allows 3 requests a minute, so indexing a long history can take hours. Chatting is never held up — new messages are
          remembered as the queue clears. A payment method raises the limit to 2,000 a minute and keeps the free tokens.
        </Callout>
      ) : null}
    </div>
  )
}

// ── backfill consent (07 C12) ─────────────────────────────────────────────────────────────────
export function BackfillDialog({ open, onClose, estimate }: { open: boolean; onClose: () => void; estimate: BackfillEstimate | null }): ReactNode {
  const [choice, setChoice] = useState<'all' | 'new' | 'sessions'>('all')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || choice !== 'sessions' || sessions) return
    const ctl = new AbortController()
    api('GET /api/sessions', { query: { limit: 200 }, signal: ctl.signal })
      .then((r) => setSessions(r.items))
      .catch((e: unknown) => {
        if (!(e instanceof DOMException)) setError(toApiError(e).message)
      })
    return () => ctl.abort()
  }, [open, choice, sessions])

  const eligible = useMemo(() => (sessions ?? []).filter((s) => !s.private && !s.temporary && s.messageCount > 0), [sessions])
  const chosenMessages = eligible.filter((s) => chosen.has(s.uid)).reduce((n, s) => n + s.messageCount, 0)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const r = await api('POST /api/memory/backfill', { body: choice === 'sessions' ? { choice, sessionUids: [...chosen] } : { choice } })
      toast.success(
        r.queued > 0 ? `Indexing ${plural(r.queued, 'message')} in the background — ${formatDuration(r.estSeconds)}.` : 'Only new messages will be remembered.'
      )
      onClose()
    } catch (e) {
      setError(toApiError(e).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title={estimate ? backfillQuestion(estimate) : 'Index your past chats?'}
      description={estimate ? backfillDetail(estimate) : undefined}
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Not now
          </Button>
          <Button variant="primary" loading={busy} disabled={choice === 'sessions' && chosen.size === 0} onClick={() => void submit()}>
            {choice === 'new' ? 'Only new messages' : 'Start indexing'}
          </Button>
        </>
      }
    >
      <div className="backfill" data-testid="backfill-dialog">
        <RadioGroup
          label="What to index"
          labelHidden
          value={choice}
          onChange={setChoice}
          name="backfill-choice"
          options={[
            { value: 'all', label: 'All past chats', description: 'Best recall from day one.' },
            { value: 'new', label: 'Only new messages', description: 'Nothing from before today is sent to Voyage.' },
            { value: 'sessions', label: 'Let me choose chats', description: 'Pick which conversations to index now.' }
          ]}
        />
        {choice === 'sessions' ? (
          <div className="backfill__list" role="group" aria-label="Chats to index">
            {!sessions ? (
              <Skeleton lines={4} />
            ) : eligible.length === 0 ? (
              <p className="mnote">No chats with messages to index.</p>
            ) : (
              eligible.map((s) => (
                <Checkbox
                  key={s.uid}
                  checked={chosen.has(s.uid)}
                  onChange={(on) =>
                    setChosen((cur) => {
                      const next = new Set(cur)
                      if (on) next.add(s.uid)
                      else next.delete(s.uid)
                      return next
                    })
                  }
                  label={s.title || 'New chat'}
                  description={`#${s.shortId} · ${plural(s.messageCount, 'message')}`}
                />
              ))
            )}
            {chosen.size > 0 ? <p className="mnote">{`${plural(chosen.size, 'chat')} · ${plural(chosenMessages, 'message')}`}</p> : null}
          </div>
        ) : null}
        {error ? (
          <p className="confirm__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  )
}
