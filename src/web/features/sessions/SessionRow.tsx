/**
 * One chat in the sidebar: a link (roving tab stop) with the title and its badges (private, temporary, imported,
 * links, custom prompt, memory off), a "More" menu button (also the right-click / long-press / Shift+F10 menu) and
 * inline rename.
 * The menu button sits next to the link, never inside it (no nested interactive content).
 */
import { memo, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Archive, BrainCog, Copy, Ellipsis, Ghost, Import, Link2, Lock, MessageSquareReply, Pencil, Pin, PinOff, ScrollText, Trash2 } from 'lucide-react'
import { formatShortId } from '@shared/ids'
import type { SessionSummary } from '@shared/types/domain'
import { ContextMenu } from '../../components/ContextMenu'
import { IconButton } from '../../components/IconButton'
import { Menu, type MenuItem } from '../../components/Menu'
import { Link } from '../../lib/router'
import { titleOf } from './group.logic'

export interface RowActions {
  rename(uid: string, title: string): void
  startRename(uid: string): void
  cancelRename(): void
  pin(uid: string, pinned: boolean): void
  archive(uid: string): void
  remove(uid: string): void
  copyId(shortId: string): void
  continueIn(uid: string): void
  /** Keyboard handling for the roving list (arrows, F2, Delete). */
  onKeyDown(e: KeyboardEvent<HTMLAnchorElement>, s: SessionSummary): void
  onFocus(uid: string): void
}

export interface SessionRowProps {
  session: SessionSummary
  current: boolean
  tabStop: boolean
  renaming: boolean
  actions: RowActions
}

export { titleOf }

const IMPORT_SOURCE: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude', vesper: 'a Vesper export' }

/** "Imported from ChatGPT" for chats brought in by Settings → Data → Import (07 A4; SessionSummary.imported). */
export function importedLabel(s: Pick<SessionSummary, 'imported'>): string | null {
  return s.imported ? `Imported from ${IMPORT_SOURCE[s.imported] ?? s.imported}` : null
}

function describe(s: SessionSummary): string {
  const parts: string[] = []
  if (s.temporary) parts.push('temporary')
  if (s.private) parts.push('private')
  const imported = importedLabel(s)
  if (imported) parts.push(imported.toLowerCase())
  if (s.linkCount) parts.push(s.linkCount === 1 ? 'linked to 1 chat' : `linked to ${s.linkCount} chats`)
  if (s.hasPrompt) parts.push('custom system prompt')
  if (s.memory === 'off') parts.push('memory off')
  return parts.join(', ')
}

export const SessionRow = memo(function SessionRow({ session: s, current, tabStop, renaming, actions }: SessionRowProps): ReactNode {
  const title = titleOf(s)
  const items: MenuItem[] = s.temporary
    ? [
        { id: 'copy', label: `Copy ID ${formatShortId(s.shortId)}`, icon: <Copy />, onSelect: () => actions.copyId(s.shortId) },
        { kind: 'separator' },
        { id: 'end', label: 'End temporary chat', icon: <Trash2 />, danger: true, onSelect: () => actions.remove(s.uid) }
      ]
    : [
        { id: 'rename', label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: () => actions.startRename(s.uid) },
        s.pinned
          ? { id: 'unpin', label: 'Unpin', icon: <PinOff />, onSelect: () => actions.pin(s.uid, false) }
          : { id: 'pin', label: 'Pin to top', icon: <Pin />, onSelect: () => actions.pin(s.uid, true) },
        { id: 'copy', label: `Copy ID ${formatShortId(s.shortId)}`, icon: <Copy />, onSelect: () => actions.copyId(s.shortId) },
        { id: 'continue', label: 'Continue in a new chat', icon: <MessageSquareReply />, onSelect: () => actions.continueIn(s.uid) },
        { kind: 'separator' },
        { id: 'archive', label: 'Archive', icon: <Archive />, onSelect: () => actions.archive(s.uid) },
        { id: 'delete', label: 'Move to Trash', icon: <Trash2 />, shortcut: 'Del', danger: true, onSelect: () => actions.remove(s.uid) }
      ]
  const meta = describe(s)

  return (
    <div className={`srow${current ? ' is-current' : ''}${renaming ? ' is-renaming' : ''}`} data-session={s.uid}>
      {renaming ? (
        <RenameField initial={s.title} onDone={(t) => (t === null ? actions.cancelRename() : actions.rename(s.uid, t))} />
      ) : (
        <ContextMenu aria-label={`Actions for ${title}`} items={items}>
          <Link
            to={`/s/${s.uid}`}
            className="srow__link"
            aria-current={current ? 'page' : undefined}
            tabIndex={tabStop ? 0 : -1}
            data-uid={s.uid}
            onKeyDown={(e) => actions.onKeyDown(e, s)}
            onFocus={() => actions.onFocus(s.uid)}
            onDoubleClick={(e) => {
              if (s.temporary) return
              e.preventDefault()
              actions.startRename(s.uid)
            }}
          >
            {s.temporary ? <Ghost className="srow__lead" aria-hidden="true" /> : null}
            <span className="srow__title">{title}</span>
            {meta ? <span className="sr-only">, {meta}</span> : null}
            <span className="srow__badges" aria-hidden="true">
              {s.private ? <Lock /> : null}
              {s.imported ? (
                <span className="srow__imported" title={importedLabel(s) ?? undefined}>
                  <Import />
                </span>
              ) : null}
              {s.memory === 'off' ? <BrainCog className="is-off" /> : null}
              {s.hasPrompt ? <ScrollText /> : null}
              {s.linkCount ? (
                <span className="srow__links">
                  <Link2 />
                  {s.linkCount}
                </span>
              ) : null}
            </span>
          </Link>
        </ContextMenu>
      )}
      {renaming ? null : (
        <Menu
          aria-label={`Actions for ${title}`}
          placement="bottom-end"
          items={items}
          trigger={<IconButton className="srow__more" label={`More for ${title}`} icon={<Ellipsis />} size="sm" tabIndex={-1} tooltip={false} />}
        />
      )}
    </div>
  )
})

/** Inline rename: Enter or leaving the field saves, Esc cancels. */
function RenameField({ initial, onDone }: { initial: string; onDone: (title: string | null) => void }): ReactNode {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (v: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(v === null || v.trim() === '' || v.trim() === initial ? null : v.trim())
  }
  return (
    <input
      ref={ref}
      className="srow__rename"
      aria-label="Chat title"
      value={value}
      maxLength={200}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }}
      onBlur={() => finish(value)}
    />
  )
}
