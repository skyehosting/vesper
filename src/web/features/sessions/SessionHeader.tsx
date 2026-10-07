/**
 * The chat's top bar content (01 "Layout"; v1.1: the avatar lives behind the messages, not here — presence
 * ChatBackdrop): the title (click to rename inline), the session ID (click to copy), and the model and memory chips. Temporary and
 * private chats say so. The model chip opens a picker; the memory chip opens the panel's memory section.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { BrainCircuit, ChevronDown, CloudUpload, Cpu, Ghost, Lock } from 'lucide-react'
import { formatShortId } from '@shared/ids'
import type { Session, SessionSummary } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { Combobox } from '../../components/Combobox'
import { Popover } from '../../components/Popover'
import { Select } from '../../components/Select'
import { Spinner } from '../../components/Spinner'
import { Tooltip } from '../../components/Tooltip'
import { toApiError } from '../../lib/errors.logic'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { getModels } from './cache'
import { memoryChip, modelChip, shortModel } from './chips.logic'
import { copySessionId, renameSession, trySession } from './data'
import { titleOf } from './group.logic'
import { TEMPORARY_CHAT_PILL_LABEL, TEMPORARY_CHAT_TOOLTIP } from './temporaryChat.logic'

export function SessionHeader({ uid, phone }: { uid: string; phone: boolean }): ReactNode {
  const detail = useStore((s) => (s.activeSession?.uid === uid ? s.activeSession : null))
  const row = useStore((s) => s.sessions.items.find((x) => x.uid === uid) ?? null)
  const session: Session | SessionSummary | null = detail ?? row
  const missing = useStore((s) => s.activeSessionUid === uid && s.activeSessionError?.code === 'not_found')
  const title = session ? titleOf(session) : ''

  useEffect(() => {
    if (!title) return
    document.title = `${title} · Vesper`
    return () => {
      document.title = 'Vesper'
    }
  }, [title])

  return (
    <div className="shead">
      {session ? (
        <>
          <TitleEditor uid={uid} title={title} editable={!session.temporary} />
          {phone ? null : (
            <Tooltip content="Copy chat ID" side="bottom" describe={false}>
              <button type="button" className="shead__id" onClick={() => void copySessionId(session.shortId)} aria-label={`Chat ID ${formatShortId(session.shortId)}, copy`}>
                {formatShortId(session.shortId)}
              </button>
            </Tooltip>
          )}
          {session.temporary ? (
            <Tooltip content={TEMPORARY_CHAT_TOOLTIP} side="bottom" describe={false}>
              <span className="shead__pill shead__pill--temp" tabIndex={0} role="note" aria-label={TEMPORARY_CHAT_PILL_LABEL}>
                <Ghost aria-hidden="true" />
                Temporary
              </span>
            </Tooltip>
          ) : null}
          {session.private && !session.temporary ? (
            <Tooltip content="Private: never sent to Voyage AI and never recalled from other chats." side="bottom" describe={false}>
              <span className="shead__pill" tabIndex={0} role="note" aria-label="Private chat: never sent to Voyage AI and never recalled from other chats">
                <Lock aria-hidden="true" />
                {phone ? null : 'Private'}
              </span>
            </Tooltip>
          ) : null}
          {phone ? null : (
            <div className="shead__chips">
              <ModelChip session={detail} />
              <MemoryChip session={session} />
            </div>
          )}
        </>
      ) : missing ? (
        <h1 className="shead__title">
          <span className="shead__title-text shead__title-text--muted">Chat not found</span>
        </h1>
      ) : (
        <span className="shead__title-skeleton" aria-hidden="true" />
      )}
    </div>
  )
}

function TitleEditor({ uid, title, editable }: { uid: string; title: string; editable: boolean }): ReactNode {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const input = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const done = useRef(false)

  useEffect(() => {
    if (!editing) return
    done.current = false
    input.current?.focus()
    input.current?.select()
  }, [editing])

  // Another device renamed it (or the auto-title arrived) while not editing.
  useEffect(() => {
    if (!editing) setValue(title)
  }, [title, editing])

  const finish = (save: boolean): void => {
    if (done.current) return
    done.current = true
    setEditing(false)
    const next = value.trim()
    if (save && next && next !== title) void renameSession(uid, next)
    else setValue(title)
    requestAnimationFrame(() => button.current?.focus({ preventScroll: true }))
  }

  if (editing) {
    return (
      <input
        ref={input}
        className="shead__title-input no-drag"
        aria-label="Chat title"
        value={value}
        maxLength={200}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            finish(false)
          }
        }}
      />
    )
  }
  return (
    <h1 className="shead__title">
      {editable ? (
        <button ref={button} type="button" className="shead__title-btn" title={`${title} — click to rename`} onClick={() => setEditing(true)}>
          <span className="sr-only">Rename chat: </span>
          {title}
        </button>
      ) : (
        <span className="shead__title-text">{title}</span>
      )}
    </h1>
  )
}

function ModelChip({ session }: { session: Session | null }): ReactNode {
  const settings = useStore((s) => s.settings)
  const info = modelChip(settings, session)
  const label = info.model ? shortModel(info.model) : 'Choose a model'
  return (
    <Popover
      title="Model for this chat"
      width={340}
      placement="bottom-start"
      trigger={
        <button type="button" className={`schip${info.overridden ? ' is-set' : ''}`} title={info.model ?? undefined} aria-label={`Model: ${info.model ?? 'not set'}${info.leavesPc ? `, text is sent to ${info.service}` : info.mayForward ? `, text goes to a program on this PC that may forward it` : ''}. Change`}>
          <Cpu aria-hidden="true" />
          <span className="schip__text">{label}</span>
          {info.leavesPc ? <CloudUpload className="schip__cloud" aria-hidden="true" /> : null}
          <ChevronDown className="schip__caret" aria-hidden="true" />
        </button>
      }
    >
      {(close) => (session ? <ModelPicker session={session} onDone={close} compact /> : <Spinner label="Loading" />)}
    </Popover>
  )
}

const DEFAULT = '__default__'

/** Profile (when there are several) + a searchable model list; "Default" clears the override. */
/** `compact`: inside the top bar's popover, whose title already says what this is (the field label is visually hidden). */
export function ModelPicker({ session, onDone, compact = false }: { session: Session; onDone?: () => void; compact?: boolean }): ReactNode {
  const settings = useStore((s) => s.settings)
  const profiles = settings?.llm.profiles ?? []
  const info = modelChip(settings, session)
  const [models, setModels] = useState<{ id: string; label?: string; description?: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const profile = profiles.find((p) => p.id === info.profileId) ?? null

  useEffect(() => {
    if (!info.profileId) return
    let alive = true
    setModels(null)
    setError(null)
    getModels(info.profileId)
      .then((list) => {
        if (!alive) return
        setModels(
          list.map((m) => ({
            id: m.id,
            label: m.label,
            description: [m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : null, m.caps?.vision ? 'vision' : null, m.caps?.reasoning ? 'reasoning' : null].filter(Boolean).join(' · ') || undefined
          }))
        )
      })
      .catch((e: unknown) => {
        if (alive) setError(toApiError(e).message)
      })
    return () => {
      alive = false
    }
  }, [info.profileId])

  if (!profiles.length) {
    return (
      <div className="spicker">
        <p className="spicker__note">Add an AI provider first: your own API URL and key, or a local model.</p>
        <Button size="sm" variant="secondary" icon={<Cpu />} onClick={() => navigate('/settings/providers')}>
          Open AI providers
        </Button>
      </div>
    )
  }

  const typed = query.trim()
  const options = [
    { value: DEFAULT, label: `Default (${profile?.model || 'not set'})` },
    ...(models ?? []).map((m) => ({ value: m.id, label: m.label ?? m.id, description: m.description })),
    // A model the provider didn't list (or a list that failed): use what was typed.
    ...(typed && !(models ?? []).some((m) => m.id === typed) ? [{ value: typed, label: `Use “${typed}”` }] : [])
  ]
  const filtered = typed ? options.filter((o) => o.value === typed || o.label.toLowerCase().includes(typed.toLowerCase()) || o.value.toLowerCase().includes(typed.toLowerCase())) : options
  const current = session.model ?? DEFAULT

  return (
    <div className="spicker">
      {profiles.length > 1 ? (
        <Select
          label="AI provider"
          value={info.profileId}
          options={profiles.map((p) => ({ value: p.id, label: p.label }))}
          onChange={(v) => void trySession(session.uid, { llmProfile: v === settings?.llm.defaultProfile ? null : v, model: null })}
        />
      ) : null}
      <Combobox
        label="Model"
        labelHidden={compact}
        value={current}
        options={filtered}
        loading={models === null && !error}
        onQueryChange={setQuery}
        emptyText={error ? `Couldn't list models: ${error}. Type a model ID.` : 'No model matches.'}
        onChange={(v) => {
          if (v === null) return
          void trySession(session.uid, { model: v === DEFAULT ? null : v }).then(() => onDone?.())
        }}
      />
      {info.leavesPc ? <p className="spicker__note">Messages in this chat are sent to {info.service}.</p> : null}
      {info.mayForward ? (
        <p className="spicker__note">Messages in this chat go to a program on this PC ({info.service}); it may pass them on to an online service.</p>
      ) : null}
    </div>
  )
}

function MemoryChip({ session }: { session: Session | SessionSummary }): ReactNode {
  const enabled = useStore((s) => s.settings?.memory.enabled ?? false)
  const state = useStore((s) => s.ui.memoryStatus?.state ?? null)
  const open = useStore((s) => s.setPanelOpen)
  const info = memoryChip(enabled, session.memory, state, session.private)
  return (
    <Tooltip content={info.detail} side="bottom" describe={false}>
      <button type="button" className={`schip schip--mem schip--${info.tone}`} aria-label={`${info.label}. ${info.detail} Open memory settings for this chat`} onClick={() => open(true, 'memory')}>
        <BrainCircuit aria-hidden="true" />
        <span className="schip__text">{info.label}</span>
      </button>
    </Tooltip>
  )
}
