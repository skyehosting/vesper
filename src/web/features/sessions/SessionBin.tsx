/**
 * The sidebar's Trash and Archived views. Trash: deleted chats stay 30 days (07 B9 daily purge), each can be restored,
 * and "Empty trash" deletes them for good after a confirmation. Archived: hidden from the list but kept (and still
 * recallable); each can be opened or brought back. Both refresh on `sessions.changed`.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArchiveRestore, ArrowLeft, Ghost, RotateCcw, Trash2 } from 'lucide-react'
import { formatDate, partsOf } from './dates'
import type { SessionSummary } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { IconButton } from '../../components/IconButton'
import { Spinner } from '../../components/Spinner'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { Link, navigate } from '../../lib/router'
import type { ApiError } from '@shared/errors'
import { ws } from '../../lib/ws'
import { emptyTrash, restoreSession, unarchiveSession } from './data'
import { titleOf } from './group.logic'

export function SessionBin({ kind, onBack }: { kind: 'trash' | 'archived'; onBack: () => void }): ReactNode {
  const [items, setItems] = useState<SessionSummary[] | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  const load = useCallback(
    (signal?: AbortSignal): void => {
      api('GET /api/sessions', { query: { filter: kind, limit: 200 }, signal })
        .then((r) => {
          if (signal?.aborted) return
          setItems(r.items)
          setError(null)
        })
        .catch((e: unknown) => {
          if (!signal?.aborted) setError(toApiError(e))
        })
    },
    [kind]
  )

  useEffect(() => {
    const ctrl = new AbortController()
    setItems(null)
    load(ctrl.signal)
    const off = ws.on('sessions.changed', () => load(ctrl.signal))
    return () => {
      ctrl.abort()
      off()
    }
  }, [load])

  const bringBack = async (s: SessionSummary): Promise<void> => {
    setBusy(s.uid)
    const ok = kind === 'trash' ? await restoreSession(s.uid) : await unarchiveSession(s.uid)
    setBusy(null)
    if (ok) setItems((cur) => cur?.filter((x) => x.uid !== s.uid) ?? cur)
  }

  const trash = kind === 'trash'
  const title = trash ? 'Trash' : 'Archived'
  return (
    <div className="sbin">
      <div className="sbin__head">
        <IconButton label="Back to chats" icon={<ArrowLeft />} size="sm" onClick={onBack} data-sheet-autofocus />
        <h2 className="sbin__title" id={`sbin-${kind}`}>
          {title}
        </h2>
        {trash && items && items.length ? (
          <Button size="sm" variant="ghost" className="sbin__empty-btn" icon={<Trash2 />} onClick={() => setConfirm(true)}>
            Empty
          </Button>
        ) : null}
      </div>
      <p className="sbin__note">
        {trash ? 'Chats in the Trash are deleted for good after 30 days. Backups keep a copy until they rotate out (about 5 weeks).' : 'Archived chats are hidden from the list. Memory can still recall them.'}
      </p>
      <div className="sbin__list" aria-labelledby={`sbin-${kind}`} aria-busy={items === null || undefined}>
        {error ? (
          <ErrorState compact error={error} onRetry={() => load()} />
        ) : items === null ? (
          <div className="sidebar__state" data-loading>
            <Spinner label={`Loading ${title.toLowerCase()}`} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            size="sm"
            headingLevel={3}
            icon={trash ? <Trash2 /> : <ArchiveRestore />}
            title={trash ? 'Trash is empty' : 'Nothing archived'}
            description={trash ? 'Deleted chats wait here for 30 days.' : 'Archive a chat from its menu to tuck it away.'}
          />
        ) : (
          items.map((s) => (
            <div key={s.uid} className="sbin__row">
              {trash ? (
                <span className="sbin__name">
                  {s.temporary ? <Ghost aria-hidden="true" /> : null}
                  <span className="sbin__name-text">{titleOf(s)}</span>
                  <span className="sbin__meta">{s.deletedUtc ? `Deleted ${formatDate(partsOf(s.deletedUtc))}` : null}</span>
                </span>
              ) : (
                <Link className="sbin__name sbin__name--link" to={`/s/${s.uid}`}>
                  <span className="sbin__name-text">{titleOf(s)}</span>
                  <span className="sbin__meta">{s.messageCount === 1 ? '1 message' : `${s.messageCount} messages`}</span>
                </Link>
              )}
              <IconButton
                label={trash ? `Restore ${titleOf(s)}` : `Unarchive ${titleOf(s)}`}
                icon={trash ? <RotateCcw /> : <ArchiveRestore />}
                size="sm"
                loading={busy === s.uid}
                onClick={() =>
                  void bringBack(s).then(() => {
                    if (trash) navigate(`/s/${s.uid}`)
                  })
                }
              />
            </div>
          ))
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        tone="danger"
        title="Empty the Trash?"
        description={`${items?.length === 1 ? 'This chat' : `These ${items?.length ?? 0} chats`} and everything in ${items?.length === 1 ? 'it' : 'them'} will be deleted for good, including their memory. This can't be undone.`}
        confirmLabel="Delete for good"
        onConfirm={async () => {
          const n = await emptyTrash()
          if (n !== null) setItems([])
        }}
      />
    </div>
  )
}
