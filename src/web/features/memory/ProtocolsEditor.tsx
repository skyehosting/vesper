/**
 * Memory viewer → Protocols (R9, 07 C1/B2): the protocols file every chat's AI follows. A comfortable monospace editor
 * (textarea + line numbers; no editor dependency), live validation warnings (mirrored from the server, whose warnings
 * after saving are authoritative), the placeholder and mode-block reference with Insert, differences against the
 * shipped default, reset to default (confirm), and — because running chats froze the old text in their epoch —
 * "Apply to a chat now" (POST /api/sessions/:uid/epoch). Editing is desktop-only; other devices read.
 * Ctrl+S saves. Unsaved text survives switching tabs (module draft) and the page warns before unloading it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { CheckCircle2, FileDiff, PencilLine, RotateCcw, Save, Undo2 } from 'lucide-react'
import DEFAULT_PROTOCOLS from '@shared/protocols.default.md?raw'
import { formatShortId } from '@shared/ids'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Callout } from '../../components/Callout'
import { Combobox } from '../../components/Combobox'
import { useConfirm } from '../../components/ConfirmDialog'
import { Disclosure } from '../../components/Disclosure'
import { ErrorState } from '../../components/ErrorState'
import { Kbd } from '../../components/Kbd'
import { Segmented } from '../../components/Segmented'
import { Skeleton } from '../../components/Skeleton'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import type { ApiError } from '@shared/errors'
import { useIsPhone } from '../../lib/useMediaQuery'
import { useLive } from './live'
import { manifest } from './stores'
import { byActivity } from './manifest.logic'
import { errorText, plural, shortHash } from './format.logic'
import { BLOCK_HELP, diffHunks, insertAt, lineCount, lineDiff, MAX_PROTOCOLS_CHARS, PLACEHOLDER_HELP, validateProtocols } from './protocols.logic'
import { useIsDesktop } from './settings'
import { cx } from './cx'

export const DEFAULT_TEXT = DEFAULT_PROTOCOLS.replace(/\r\n/g, '\n')

interface Loaded {
  text: string
  isDefault: boolean
  hash: string
  warnings: string[]
}

/** Unsaved edits survive switching tabs within the viewer (cleared on save/revert). */
let draftCache: { base: string; text: string } | null = null

export function ProtocolsEditor(): ReactNode {
  const desktop = useIsDesktop()
  const phone = useIsPhone()
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<ApiError | null>(null)
  const [text, setText] = useState('')
  const [view, setView] = useState<'edit' | 'diff'>('edit')
  const [saving, setSaving] = useState(false)
  const [savedNote, setSavedNote] = useState<{ warnings: string[] } | null>(null)
  const { confirm, dialog } = useConfirm()
  const areaRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null)
    try {
      const r = await api('GET /api/protocols')
      setLoaded(r)
      setText(draftCache && draftCache.base === r.text ? draftCache.text : r.text)
    } catch (e) {
      setLoadError(toApiError(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = loaded !== null && text !== loaded.text
  useEffect(() => {
    if (loaded) draftCache = dirty ? { base: loaded.text, text } : null
  }, [dirty, loaded, text])

  // Leaving the app with unsaved protocols asks first (owned listener, removed when clean or unmounted).
  useEffect(() => {
    if (!dirty) return
    const onBefore = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBefore)
    return () => window.removeEventListener('beforeunload', onBefore)
  }, [dirty])

  const warnings = useMemo(() => validateProtocols(text), [text])
  const tooLong = text.length > MAX_PROTOCOLS_CHARS
  const empty = text.trim() === ''

  const save = useCallback(async (): Promise<void> => {
    if (!dirty || saving || tooLong || empty || !desktop) return
    setSaving(true)
    try {
      const r = await api('PUT /api/protocols', { body: { text } })
      setLoaded({ text: text.replace(/\r\n/g, '\n'), isDefault: text === DEFAULT_TEXT, hash: r.hash, warnings: r.warnings })
      setText(text.replace(/\r\n/g, '\n'))
      draftCache = null
      setSavedNote({ warnings: r.warnings })
      toast.success('Protocols saved.')
    } catch (e) {
      toast.error(errorText(toApiError(e)), { title: 'Couldn’t save the protocols' })
    } finally {
      setSaving(false)
    }
  }, [dirty, saving, tooLong, empty, desktop, text])

  const reset = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Go back to the default protocols?',
      description:
        'Your version is replaced by the one that ships with Vesper (future app updates of the default then apply automatically). Running chats keep what they started with.',
      confirmLabel: 'Reset to default',
      tone: 'danger'
    })
    if (!ok) return
    try {
      const r = await api('POST /api/protocols/reset')
      draftCache = null
      setLoaded({ text: DEFAULT_TEXT, isDefault: true, hash: r.hash, warnings: [] })
      setText(DEFAULT_TEXT)
      setSavedNote({ warnings: [] })
      toast.success('Back to the default protocols.')
    } catch (e) {
      toast.error(toApiError(e).message)
    }
  }

  const revert = (): void => {
    if (!loaded) return
    setText(loaded.text)
    draftCache = null
  }

  const insert = (token: string): void => {
    const el = areaRef.current
    if (!el || !desktop) return
    const r = insertAt(text, el.selectionStart, el.selectionEnd, token)
    setText(r.value)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(r.caret, r.caret)
    })
  }

  if (loadError && !loaded) return <ErrorState error={loadError} onRetry={() => void load()} />
  if (!loaded)
    return (
      <div data-loading>
        <Skeleton variant="rect" height={360} />
      </div>
    )

  const diff = view === 'diff' ? lineDiff(DEFAULT_TEXT, text) : null
  const reference = (
    <div className="mprot__ref">
      <h3 className="mprot__ref-title">Placeholders</h3>
      <ul className="mprot__tokens">
        {PLACEHOLDER_HELP.map((p) => (
          <li key={p.token}>
            <button
              type="button"
              className="mprot__token mono"
              onClick={() => insert(p.token)}
              disabled={!desktop || view !== 'edit'}
              title={`Insert ${p.token}`}
            >
              {p.token}
            </button>
            <span>{p.text}</span>
          </li>
        ))}
      </ul>
      <h3 className="mprot__ref-title">Mode blocks</h3>
      <ul className="mprot__tokens">
        {BLOCK_HELP.map((p) => (
          <li key={p.token}>
            <code className="mprot__token mono">{p.token}</code>
            <span>{p.text}</span>
          </li>
        ))}
      </ul>
      <p className="mnote">Changes apply to new conversations and fresh contexts. No clock goes in here: every message already tells the AI the time.</p>
    </div>
  )

  return (
    <div className="mprot">
      <div className="mprot__bar">
        <div className="mprot__state">
          {loaded.isDefault && !dirty ? <Badge tone="neutral">Default</Badge> : <Badge tone="accent">Your version</Badge>}
          {dirty ? (
            <Badge tone="warning" dot>
              Unsaved
            </Badge>
          ) : (
            <span className="mprot__hash mono" title={`SHA-256 ${loaded.hash}`}>
              {shortHash(loaded.hash)}
            </span>
          )}
        </div>
        <Segmented
          aria-label="View"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: 'edit', label: 'Edit', icon: <PencilLine /> },
            { value: 'diff', label: 'Changes from default', icon: <FileDiff /> }
          ]}
        />
        <div className="mprot__actions">
          {dirty ? (
            <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={revert}>
              Revert
            </Button>
          ) : null}
          <Button size="sm" icon={<RotateCcw />} disabled={!desktop || (loaded.isDefault && !dirty)} onClick={() => void reset()}>
            Reset to default
          </Button>
          <Button size="sm" variant="primary" icon={<Save />} loading={saving} disabled={!desktop || !dirty || tooLong || empty} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
      {!desktop ? <p className="mnote">The protocols can only be edited in the Vesper app on your PC.</p> : null}

      <div className={cx('mprot__main', phone && 'mprot__main--phone')}>
        <div className="mprot__editor-col">
          {view === 'edit' ? (
            <LineEditor
              ref={areaRef}
              value={text}
              readOnly={!desktop}
              wrap={phone}
              onChange={(v) => {
                setText(v)
                setSavedNote(null)
              }}
              onSave={() => void save()}
            />
          ) : (
            <DiffView ops={diff} />
          )}
          <p className="mprot__count tabular" aria-live="off">
            {plural(lineCount(text), 'line')} · {text.length.toLocaleString('en-US')} / {MAX_PROTOCOLS_CHARS.toLocaleString('en-US')} characters
            {desktop ? (
              <>
                {' '}
                · <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> saves
              </>
            ) : null}
          </p>
          {empty ? <Callout tone="danger">The protocols can’t be empty. Use Reset to go back to the default.</Callout> : null}
          {tooLong ? <Callout tone="danger">{`That’s over ${MAX_PROTOCOLS_CHARS.toLocaleString('en-US')} characters; shorten it to save.`}</Callout> : null}
          {warnings.length ? (
            <Callout tone="warning" title={plural(warnings.length, 'thing') + ' to check'}>
              <ul className="mprot__warnings" data-testid="protocol-warnings">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p className="mnote">Warnings never block saving.</p>
            </Callout>
          ) : (
            <p className="mprot__ok">
              <CheckCircle2 aria-hidden="true" /> No problems found.
            </p>
          )}
          {savedNote && !dirty ? <ApplyNow /> : null}
        </div>
        {phone ? (
          <Disclosure summary="Placeholders and mode blocks" variant="card">
            {reference}
          </Disclosure>
        ) : (
          <aside className="mprot__aside" aria-label="Placeholders reference">
            {reference}
          </aside>
        )}
      </div>
      {dialog}
    </div>
  )
}

/** After saving: running chats keep their frozen protocols until a new epoch; offer to start one now (07 C1). */
function ApplyNow(): ReactNode {
  const { data } = useLive(manifest)
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sessions = useMemo(() => [...(data?.sessions ?? [])].sort(byActivity).slice(0, 200), [data])
  const apply = async (): Promise<void> => {
    if (!pick) return
    setBusy(true)
    try {
      await api('POST /api/sessions/:uid/epoch', { params: { uid: pick }, body: { reason: 'apply-protocols' } })
      const s = sessions.find((x) => x.uid === pick)
      toast.success(`${s ? formatShortId(s.shortId) : 'That chat'} now follows the new protocols.`)
      setPick(null)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Callout tone="success" title="Saved">
      New chats use these protocols. Chats already running keep the version they started with until their context is next condensed — or apply it to one now
      (the AI then sees a fresh summary of earlier messages).
      <div className="mprot__apply">
        <Combobox
          label="Apply to a chat now"
          labelHidden
          size="sm"
          placeholder="Choose a chat…"
          value={pick}
          onChange={setPick}
          options={sessions.map((s) => ({ value: s.uid, label: s.title || 'New chat', description: formatShortId(s.shortId), keywords: [s.shortId] }))}
          wrapClassName="mprot__apply-pick"
        />
        <Button size="sm" variant="primary" disabled={!pick} loading={busy} onClick={() => void apply()}>
          Apply now
        </Button>
      </div>
    </Callout>
  )
}

function LineEditor({
  value,
  onChange,
  onSave,
  readOnly,
  wrap,
  ref
}: {
  value: string
  onChange: (v: string) => void
  onSave: () => void
  readOnly: boolean
  wrap: boolean
  ref: Ref<HTMLTextAreaElement>
}): ReactNode {
  const gutterRef = useRef<HTMLDivElement>(null)
  const lines = lineCount(value)
  const numbers = useMemo(() => Array.from({ length: lines }, (_, i) => i + 1).join('\n'), [lines])
  return (
    <div className={cx('lined', wrap && 'lined--wrap')}>
      {!wrap ? (
        <div className="lined__gutter mono" aria-hidden="true">
          <div ref={gutterRef} className="lined__numbers">
            {numbers}
          </div>
        </div>
      ) : null}
      <textarea
        ref={ref}
        className="lined__area mono"
        aria-label="Protocols text"
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap={wrap ? 'soft' : 'off'}
        data-testid="protocols-editor"
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)`
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault()
            onSave()
          }
        }}
      />
    </div>
  )
}

function DiffView({ ops }: { ops: ReturnType<typeof lineDiff> }): ReactNode {
  if (!ops) return <Callout tone="info">The two versions are too different to compare line by line.</Callout>
  const { hunks, skippedAfter, added, removed } = diffHunks(ops)
  if (hunks.length === 0)
    return (
      <div className="mdiff mdiff--same" data-testid="protocols-diff">
        <CheckCircle2 aria-hidden="true" /> Same as the default.
      </div>
    )
  return (
    <div className="mdiff mono" data-testid="protocols-diff" tabIndex={0} aria-label={`Changes from the default: ${added} lines added, ${removed} removed`}>
      <p className="mdiff__sum">
        <span className="mdiff__plus">+{added}</span> <span className="mdiff__minus">−{removed}</span> compared with the default
      </p>
      {hunks.map((h, i) => (
        <div key={i} className="mdiff__hunk">
          {h.skippedBefore ? <div className="mdiff__skip">{`⋯ ${plural(h.skippedBefore, 'unchanged line')}`}</div> : null}
          {h.ops.map((o, k) => (
            <div key={k} className={`mdiff__line mdiff__line--${o.t}`}>
              <span className="mdiff__no">{o.t === 'add' ? '' : o.a}</span>
              <span className="mdiff__no">{o.t === 'del' ? '' : o.b}</span>
              <span className="mdiff__sign" aria-hidden="true">
                {o.t === 'add' ? '+' : o.t === 'del' ? '−' : ' '}
              </span>
              {o.t !== 'same' ? <span className="sr-only">{o.t === 'add' ? 'Added: ' : 'Removed: '}</span> : null}
              <span className="mdiff__text">{o.text || ' '}</span>
            </div>
          ))}
        </div>
      ))}
      {skippedAfter ? <div className="mdiff__skip">{`⋯ ${plural(skippedAfter, 'unchanged line')}`}</div> : null}
    </div>
  )
}
