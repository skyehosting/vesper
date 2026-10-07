/**
 * Session info (01 "Session panel"): ID (copy; used by /continue and /link), dates, message count, the context epoch
 * (07 C4), model and tokens; Export this chat (Markdown / JSON), Continue in a new chat (07 C18), and continuation
 * links both ways.
 */
import { useState, type ReactNode } from 'react'
import { ArrowRight, Copy, FileDown, MessageSquareReply } from 'lucide-react'
import { formatShortId } from '@shared/ids'
import type { Session } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { IconButton } from '../../components/IconButton'
import { toast } from '../../components/Toast'
import { parseErrorBody } from '../../lib/errors.logic'
import { Link } from '../../lib/router'
import { useStore } from '../../lib/store'
import { modelChip } from '../sessions/chips.logic'
import { continueSession, copySessionId } from '../sessions/data'
import { ageOf, stampOf } from '../sessions/dates'

const fmt = new Intl.NumberFormat('en-US')
const SUDO_TEXT = 'Exporting needs your password on this device. Sign in again with the password (or export from the PC), then try once more.'

export function InfoSection({ session }: { session: Session }): ReactNode {
  const settings = useStore((s) => s.settings)
  const items = useStore((s) => s.sessions.items)
  const model = modelChip(settings, session)
  const [exporting, setExporting] = useState<'md' | 'json' | null>(null)
  const [continuing, setContinuing] = useState(false)
  const lastActive = session.lastMessageUtc ?? session.updatedUtc
  const continuedIn = session.meta.continuedIn ? items.find((s) => s.uid === session.meta.continuedIn) : undefined
  const continuedFrom = session.meta.continuedFrom ? items.find((s) => s.uid === session.meta.continuedFrom) : undefined

  const doExport = async (format: 'md' | 'json'): Promise<void> => {
    setExporting(format)
    try {
      await downloadExport(session.uid, format, session.title || 'chat')
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="psec__body">
      <dl className="pinfo">
        <dt>Chat ID</dt>
        <dd className="pinfo__id">
          <span className="mono">{formatShortId(session.shortId)}</span>
          <IconButton size="sm" label="Copy chat ID" icon={<Copy />} onClick={() => void copySessionId(session.shortId)} />
        </dd>
        <dt>Created</dt>
        <dd>{stampOf(session.createdUtc)}</dd>
        <dt>Last active</dt>
        <dd>
          {ageOf(lastActive)}
          <span className="sr-only"> ({stampOf(lastActive)})</span>
        </dd>
        <dt>Messages</dt>
        <dd className="tabular">{fmt.format(session.messageCount)}</dd>
        <dt>Context</dt>
        <dd>{session.epoch ? (session.epoch.hasRecap ? `Summary of earlier messages + from message ${fmt.format(session.epoch.startSeq)}` : 'Full conversation') : 'Not started'}</dd>
        <dt>Model</dt>
        <dd className="pinfo__wrap">{model.model ? `${model.model}${model.profileLabel ? ` · ${model.profileLabel}` : ''}` : 'Not set'}</dd>
        <dt>Tokens</dt>
        <dd className="tabular">{session.tokens ? `${fmt.format(session.tokens.in)} in · ${fmt.format(session.tokens.out)} out` : '—'}</dd>
      </dl>

      {continuedFrom || session.meta.continuedFrom ? (
        <Link className="pinfo__cont" to={`/s/${session.meta.continuedFrom}`}>
          Continues {continuedFrom ? `“${continuedFrom.title || 'New chat'}”` : 'an earlier chat'}
          <ArrowRight aria-hidden="true" />
        </Link>
      ) : null}
      {session.meta.continuedIn ? (
        <Link className="pinfo__cont" to={`/s/${session.meta.continuedIn}`}>
          Continued in {continuedIn ? `“${continuedIn.title || 'New chat'}”` : 'a newer chat'}
          <ArrowRight aria-hidden="true" />
        </Link>
      ) : null}

      <div className="psec__row psec__row--wrap">
        {session.temporary ? null : (
          <Button
            size="sm"
            variant="secondary"
            icon={<MessageSquareReply />}
            loading={continuing}
            onClick={() => {
              setContinuing(true)
              void continueSession(session.uid).finally(() => setContinuing(false))
            }}
          >
            Continue in a new chat
          </Button>
        )}
        {session.temporary ? null : (
          <>
            <Button size="sm" variant="ghost" icon={<FileDown />} loading={exporting === 'md'} onClick={() => void doExport('md')}>
              Export Markdown
            </Button>
            <Button size="sm" variant="ghost" icon={<FileDown />} loading={exporting === 'json'} onClick={() => void doExport('json')}>
              JSON
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** A chat title as a Windows-safe file name: reserved characters become spaces, runs of spaces collapse. */
function safeFileName(title: string): string {
  return title
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

/** GET /api/export?session=… as a file download (the object URL is revoked right after the click). */
export async function downloadExport(uid: string, format: 'md' | 'json', title: string): Promise<void> {
  // Export is a sudo action (07 B2): the desktop always is; another device only right after entering the password.
  const boot = useStore.getState().bootstrap
  if (boot && !boot.desktop && !boot.device.sudo) {
    toast.info(SUDO_TEXT)
    return
  }
  let res: Response
  try {
    res = await fetch(`/api/export?session=${encodeURIComponent(uid)}&format=${format}`, { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    toast.error("Couldn't reach Vesper to export.")
    return
  }
  if (!res.ok) {
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    const err = parseErrorBody(res.status, body)
    if (err.code === 'sudo_required' || err.code === 'forbidden') toast.info(SUDO_TEXT)
    else toast.error(err.message)
    return
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = `${safeFileName(title) || 'chat'}.${format === 'md' ? 'md' : 'json'}`
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoked on the next tick: the click has started the download by then (no leaked blob URLs, 07 D14).
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
