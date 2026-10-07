/**
 * Memory viewer → Chats & links (R7, R8; 07 C13, C18): the sessions manifest (GET /api/memory/manifest) shown as
 * cards, as the text the AI gets (preview) or as raw JSON, exportable as manifest.json — and links management, the
 * owner's "links to manage which sessions the AI can access": per chat, what it can recall (outgoing) and what can
 * recall it (incoming), add/remove, optionally both ways. Links are not transitive.
 */
import { memo, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeftRight, Download, Lock, Plus, Search, Upload } from 'lucide-react'
import type { Zone } from '@shared/time'
import { formatShortId } from '@shared/ids'
import { Badge, Chip } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Checkbox } from '../../components/Checkbox'
import { Combobox } from '../../components/Combobox'
import { CopyButton } from '../../components/CopyButton'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { Segmented } from '../../components/Segmented'
import { Skeleton } from '../../components/Skeleton'
import { TextField } from '../../components/TextField'
import { toast } from '../../components/Toast'
import { VirtualList } from '../../components/VirtualList'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { Link } from '../../lib/router'
import { useLive } from './live'
import { manifest } from './stores'
import { aiManifestText, byActivity, byShortId, filterSessions, manifestJson, manifestMeta, type ManifestSession, type Scope } from './manifest.logic'
import { saveText } from './download'
import { plural } from './format.logic'
import { useSettings } from './settings'
import { useViewerZone } from './zone'

type View = 'cards' | 'ai' | 'json'

const IMPORTED: Record<string, string> = { chatgpt: 'ChatGPT', claude: 'Claude', vesper: 'a Vesper export' }

async function link(from: ManifestSession, to: ManifestSession, bothWays: boolean): Promise<void> {
  await api('PUT /api/sessions/:uid/links/:shortId', { params: { uid: from.uid, shortId: to.shortId }, body: { bothWays } })
}

async function unlink(from: ManifestSession, to: ManifestSession): Promise<void> {
  await api('DELETE /api/sessions/:uid/links/:shortId', { params: { uid: from.uid, shortId: to.shortId } })
}

export function ManifestView(): ReactNode {
  const { data, error, loading, reload } = useLive(manifest)
  const settings = useSettings()
  const { zone } = useViewerZone()
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('cards')
  const [aiFor, setAiFor] = useState<string | null>(null)
  const sessions = useMemo(() => (data ? [...data.sessions].sort(byActivity) : []), [data])
  const shown = useMemo(() => filterSessions(sessions, q), [sessions, q])
  const index = useMemo(() => byShortId(sessions), [sessions])
  const now = Date.now()
  const scope: Scope = settings?.memory.scopeDefault ?? 'linked'

  const run = async (fn: () => Promise<void>, ok: string): Promise<void> => {
    try {
      await fn()
      toast.success(ok)
      await reload()
    } catch (e) {
      toast.error(toApiError(e).message)
    }
  }

  if (error && !data) return <ErrorState error={error} onRetry={() => void reload()} />
  if (!data)
    return (
      <div className="mman__loading" data-loading={loading || undefined}>
        <Skeleton variant="rect" height={92} />
        <Skeleton variant="rect" height={92} />
      </div>
    )
  if (sessions.length === 0)
    return (
      <EmptyState
        icon={<ArrowLeftRight />}
        title="No chats yet"
        description="Each chat you start appears here with its ID, so you can decide which chats may recall which."
      />
    )

  const aiSelf = sessions.find((s) => s.uid === aiFor) ?? sessions[0]

  return (
    <div className="mman">
      <div className="mman__bar">
        <TextField
          type="search"
          label="Filter chats"
          labelHidden
          placeholder="Filter by title, #ID or summary"
          leading={<Search />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapClassName="mman__filter"
          size="sm"
        />
        <Segmented
          aria-label="Show the manifest as"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'cards', label: 'Chats' },
            { value: 'ai', label: 'As the AI sees it' },
            { value: 'json', label: 'JSON' }
          ]}
        />
        <Button size="sm" icon={<Download />} onClick={() => saveText('manifest.json', manifestJson(data))}>
          Export
        </Button>
      </div>
      <p className="mman__intro">
        {plural(sessions.length, 'chat')}. By default a chat can recall{' '}
        {scope === 'linked' ? 'itself and the chats linked from it' : scope === 'all' ? 'every chat except private ones' : 'only itself'} (
        <Link to="/settings/memory">change</Link>). Links point one way: “can recall” means that chat may look things up in the other.
      </p>

      {view === 'cards' ? (
        shown.length === 0 ? (
          <EmptyState size="sm" icon={<Search />} title={`No chat matches “${q}”`} />
        ) : (
          <VirtualList<ManifestSession>
            items={shown}
            getKey={(s) => s.uid}
            estimateSize={150}
            gap={10}
            paddingBottom={24}
            aria-label="Chats in the manifest"
            data-testid="manifest-list"
            className="mman__scroller"
            renderItem={(s) => (
              <SessionCard
                s={s}
                all={sessions}
                index={index}
                zone={zone}
                nowUtc={now}
                onLink={(to, both) =>
                  void run(
                    () => link(s, to, both),
                    both ? `Linked both ways with ${formatShortId(to.shortId)}.` : `${formatShortId(s.shortId)} can now recall ${formatShortId(to.shortId)}.`
                  )
                }
                onUnlink={(to) => void run(() => unlink(s, to), `${formatShortId(s.shortId)} no longer recalls ${formatShortId(to.shortId)}.`)}
                onUnlinkIncoming={(from) => void run(() => unlink(from, s), `${formatShortId(from.shortId)} no longer recalls ${formatShortId(s.shortId)}.`)}
              />
            )}
          />
        )
      ) : view === 'ai' ? (
        <div className="mman__ai">
          <div className="mman__ai-head">
            <Combobox
              label="In the chat"
              size="sm"
              value={aiSelf.uid}
              onChange={(v) => setAiFor(v)}
              options={sessions.map((s) => ({ value: s.uid, label: s.title || 'New chat', description: formatShortId(s.shortId), keywords: [s.shortId] }))}
              wrapClassName="mman__ai-pick"
            />
            <CopyButton text={aiManifestText(sessions, aiSelf, scope, now, zone)} variant="button" size="sm" label="Copy" />
          </div>
          <p className="mnote">
            A preview of the list the AI gets at the start of a conversation and when links change (up to 30 chats, newest first). The AI can ask for more with
            memory_sessions.
          </p>
          <pre className="mman__pre" tabIndex={0} aria-label="Manifest text the AI sees">
            {aiManifestText(sessions, aiSelf, scope, now, zone)}
          </pre>
        </div>
      ) : (
        <pre className="mman__pre mman__pre--json" tabIndex={0} aria-label="Manifest as JSON">
          {manifestJson(data)}
        </pre>
      )}
    </div>
  )
}

const SessionCard = memo(function SessionCard({
  s,
  all,
  index,
  zone,
  nowUtc,
  onLink,
  onUnlink,
  onUnlinkIncoming
}: {
  s: ManifestSession
  all: ManifestSession[]
  index: Map<string, ManifestSession>
  zone: Zone
  nowUtc: number
  onLink: (to: ManifestSession, bothWays: boolean) => void
  onUnlink: (to: ManifestSession) => void
  onUnlinkIncoming: (from: ManifestSession) => void
}): ReactNode {
  const [adding, setAdding] = useState(false)
  const [pick, setPick] = useState<string | null>(null)
  const [both, setBoth] = useState(false)
  const out = s.links.map((id) => index.get(id)).filter((x): x is ManifestSession => !!x)
  const inc = s.linkedFrom.map((id) => index.get(id)).filter((x): x is ManifestSession => !!x)
  const candidates = all.filter((o) => o.uid !== s.uid && !s.links.includes(o.shortId))
  const title = s.title || 'New chat'
  return (
    <article className="mses" aria-label={`${formatShortId(s.shortId)} ${title}`} data-testid="manifest-session" data-short={s.shortId}>
      <div className="mses__head">
        <span className="mses__id mono">{formatShortId(s.shortId)}</span>
        <Link to={`/s/${encodeURIComponent(s.uid)}`} className="mses__title">
          {title}
        </Link>
        <span className="mses__badges">
          {s.private ? (
            <Badge icon={<Lock />} tone="neutral">
              Private
            </Badge>
          ) : null}
          {s.memory === 'off' ? <Badge tone="neutral">Memory off</Badge> : null}
          {s.imported ? (
            <Badge tone="info" icon={<Upload />}>
              {`Imported from ${IMPORTED[s.imported] ?? s.imported}`}
            </Badge>
          ) : null}
          {s.archived ? <Badge tone="neutral">Archived</Badge> : null}
        </span>
      </div>
      <p className="mses__meta">
        {manifestMeta(s, nowUtc, zone)}
      </p>
      {s.summary ? <p className="mses__summary">{s.summary}</p> : null}
      {s.private ? <p className="mnote">Private: other chats never recall it, even when linked.</p> : null}
      <div className="mses__links">
        <div className="mses__linkrow">
          <span className="mses__linklabel">Can recall</span>
          <span className="mses__chips">
            {out.length === 0 ? <span className="mses__none">only itself</span> : null}
            {out.map((o) => (
              <Chip
                key={o.uid}
                size="sm"
                onRemove={() => onUnlink(o)}
                removeLabel={`Stop ${formatShortId(s.shortId)} recalling ${formatShortId(o.shortId)}`}
                title={o.title}
              >
                <span className="mono">{formatShortId(o.shortId)}</span> {o.title || 'Untitled'}
              </Chip>
            ))}
            {!adding && candidates.length > 0 ? (
              <Button size="sm" variant="ghost" icon={<Plus />} onClick={() => setAdding(true)}>
                Link a chat
              </Button>
            ) : null}
          </span>
        </div>
        {adding ? (
          <div className="mses__add">
            <Combobox
              label={`Chat ${formatShortId(s.shortId)} may recall`}
              size="sm"
              value={pick}
              onChange={setPick}
              options={candidates.map((o) => ({
                value: o.uid,
                label: o.title || 'New chat',
                description: formatShortId(o.shortId) + (o.private ? ' · private' : ''),
                keywords: [o.shortId]
              }))}
              placeholder="Find a chat…"
              wrapClassName="mses__pick"
            />
            <Checkbox checked={both} onChange={setBoth} label="Both ways" />
            <div className="mses__add-actions">
              <Button size="sm" onClick={() => (setAdding(false), setPick(null))}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!pick}
                onClick={() => {
                  const to = all.find((o) => o.uid === pick)
                  if (to) onLink(to, both)
                  setAdding(false)
                  setPick(null)
                  setBoth(false)
                }}
              >
                Link
              </Button>
            </div>
          </div>
        ) : null}
        <div className="mses__linkrow">
          <span className="mses__linklabel">Recalled by</span>
          <span className="mses__chips">
            {inc.length === 0 ? <span className="mses__none">no other chat</span> : null}
            {inc.map((o) => (
              <Chip
                key={o.uid}
                size="sm"
                onRemove={() => onUnlinkIncoming(o)}
                removeLabel={`Stop ${formatShortId(o.shortId)} recalling ${formatShortId(s.shortId)}`}
                title={o.title}
              >
                <span className="mono">{formatShortId(o.shortId)}</span> {o.title || 'Untitled'}
              </Chip>
            ))}
          </span>
        </div>
      </div>
    </article>
  )
})
