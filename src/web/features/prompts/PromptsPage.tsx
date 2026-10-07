/**
 * '/prompts' — the prompt library (R11, 03 §3): saved system prompts for any chat. List + editor side by side (on
 * phones: the list, then the editor as its own view with Back). Create, rename, edit, duplicate, delete (chats that
 * used it keep their copy), and use in a chat. Live across devices via `prompts.changed`. `?id=<n>` selects one.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ArrowLeft, BookText, Copy, MessageSquare, Plus, Search, Trash2 } from 'lucide-react'
import type { Prompt } from '@shared/types/domain'
import { formatShortId } from '@shared/ids'
import type { PageProps } from '../../app/routes'
import { TopBarContent } from '../../app/topBar'
import { Badge } from '../../components/Badge'
import { Button } from '../../components/Button'
import { Combobox } from '../../components/Combobox'
import { useConfirm } from '../../components/ConfirmDialog'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { IconButton } from '../../components/IconButton'
import { Skeleton } from '../../components/Skeleton'
import { TextArea } from '../../components/TextArea'
import { TextField } from '../../components/TextField'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { getLocation, navigate } from '../../lib/router'
import { useIsPhone } from '../../lib/useMediaQuery'
import { useLive } from '../memory/live'
import { manifest } from '../memory/stores'
import { byActivity } from '../memory/manifest.logic'
import { errorText, formatCount } from '../memory/format.logic'
import { cx } from '../memory/cx'
import { applyPromptToSession, filterPrompts, PROMPT_LIMITS, uniqueName, usePrompts } from './library'
import './prompts.css'

/** Starters for an empty library (07 D13: empty states offer a way forward). */
export const STARTERS: { name: string; body: string }[] = [
  {
    name: 'Thoughtful friend',
    body: 'Talk with me like a warm, honest friend. Keep replies short unless I ask for detail, ask one good question at a time, and tell me gently when you think I’m wrong.'
  },
  {
    name: 'Writing coach',
    body: 'You are a patient writing coach. When I share text, point out the two or three changes that matter most, explain why in a sentence each, and show a revised version only when I ask.'
  },
  {
    name: 'Code reviewer',
    body: 'Review code like a senior engineer: correctness first, then clarity, then performance. Quote the lines you mean, keep each point short, and suggest concrete fixes.'
  }
]

interface Draft {
  id: number | null
  name: string
  body: string
}

function selectedFromUrl(): number | null {
  const v = new URLSearchParams(getLocation().search).get('id')
  return v && /^\d+$/.test(v) ? Number(v) : null
}

export default function PromptsPage(_props: PageProps): ReactNode {
  const phone = useIsPhone()
  const { prompts, error, reload } = usePrompts()
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<number | null>(selectedFromUrl)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)
  const { confirm, dialog } = useConfirm()

  const list = useMemo(() => filterPrompts(prompts ?? [], q), [prompts, q])
  const current = prompts?.find((p) => p.id === selected) ?? null

  // Selection → editor draft (unless the user is editing a new, unsaved one).
  useEffect(() => {
    if (current)
      setDraft((d) =>
        d && d.id === current.id && (d.name !== current.name || d.body !== current.body) ? d : { id: current.id, name: current.name, body: current.body }
      )
  }, [current])

  // Wide screens open the first prompt; the selection is kept in the URL for links and reloads.
  useEffect(() => {
    if (!phone && selected === null && draft === null && list.length) setSelected(list[0].id)
  }, [phone, selected, draft, list])
  useEffect(() => {
    const want = selected !== null ? `/prompts?id=${selected}` : '/prompts'
    if (getLocation().path !== want && getLocation().pathname === '/prompts') navigate(want, { replace: true })
  }, [selected])

  const dirty = draft !== null && (draft.id === null || !current || draft.name !== current.name || draft.body !== current.body)

  const startNew = (base?: { name: string; body: string }): void => {
    setSelected(null)
    setNameError(null)
    setDraft({ id: null, name: uniqueName(prompts ?? [], base?.name ?? 'New prompt'), body: base?.body ?? '' })
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setNameError('A prompt needs a name.')
      return
    }
    setBusy('save')
    setNameError(null)
    try {
      const p: Prompt =
        draft.id === null
          ? await api('POST /api/prompts', { body: { name, body: draft.body } })
          : await api('PATCH /api/prompts/:id', { params: { id: draft.id }, body: { name, body: draft.body } })
      await reload()
      setSelected(p.id)
      setDraft({ id: p.id, name: p.name, body: p.body })
      toast.success(`Saved “${p.name}”.`)
    } catch (e) {
      const err = toApiError(e)
      if (err.code === 'conflict' || err.fields?.name) setNameError(err.code === 'conflict' ? 'A prompt with this name already exists.' : errorText(err))
      else toast.error(errorText(err), { title: 'Couldn’t save the prompt' })
    } finally {
      setBusy(null)
    }
  }

  const remove = async (): Promise<void> => {
    if (!draft) return
    if (draft.id === null) {
      setDraft(null)
      return
    }
    const ok = await confirm({
      title: `Delete “${draft.name}”?`,
      description: 'Chats that use it keep their own copy of the text.',
      confirmLabel: 'Delete',
      tone: 'danger'
    })
    if (!ok) return
    setBusy('delete')
    try {
      await api('DELETE /api/prompts/:id', { params: { id: draft.id } })
      await reload()
      setSelected(null)
      setDraft(null)
      toast.success('Prompt deleted.')
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(null)
    }
  }

  const showEditor = draft !== null && (!phone || draft !== null)
  const showList = !phone || draft === null

  const listPane = (
    <section className="plib__list" aria-label="Saved prompts">
      <div className="plib__list-head">
        <TextField
          type="search"
          size="sm"
          label="Filter prompts"
          labelHidden
          placeholder="Filter prompts"
          leading={<Search />}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapClassName="plib__filter"
        />
        <Button size="sm" variant="primary" icon={<Plus />} onClick={() => startNew()}>
          New
        </Button>
      </div>
      {error && !prompts ? (
        <ErrorState error={error} onRetry={() => void reload()} compact />
      ) : !prompts ? (
        <div className="plib__skeleton" data-loading>
          <Skeleton lines={4} />
        </div>
      ) : prompts.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<BookText />}
          title="No saved prompts yet"
          description="A system prompt sets how the AI behaves in a chat. Save the ones you like to reuse them."
          suggestions={STARTERS.map((s) => s.name)}
          onSuggestion={(name) => startNew(STARTERS.find((s) => s.name === name))}
        />
      ) : list.length === 0 ? (
        <p className="plib__none">No prompt matches “{q}”.</p>
      ) : (
        <ul className="plib__items">
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className={cx('plib__item', p.id === selected && 'is-selected')}
                aria-current={p.id === selected ? 'true' : undefined}
                onClick={() => {
                  setNameError(null)
                  setSelected(p.id)
                  setDraft({ id: p.id, name: p.name, body: p.body })
                }}
              >
                <span className="plib__item-name">{p.name}</span>
                <span className="plib__item-preview">{p.body.trim().split('\n')[0] || 'Empty'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )

  return (
    <div className="plib">
      <TopBarContent>
        <h1 className="plib__title">Prompt library</h1>
      </TopBarContent>
      <div className={cx('plib__panes', phone && 'plib__panes--phone')}>
        {showList ? listPane : null}
        {showEditor && draft ? (
          <section className="plib__editor" aria-label="Prompt editor">
            {phone ? (
              <Button size="sm" variant="ghost" icon={<ArrowLeft />} onClick={() => (setDraft(null), setSelected(null))} className="plib__back">
                All prompts
              </Button>
            ) : null}
            <div className="plib__editor-head">
              <TextField
                label="Name"
                value={draft.name}
                maxLength={PROMPT_LIMITS.name}
                error={nameError ?? undefined}
                onChange={(e) => {
                  setDraft({ ...draft, name: e.target.value })
                  if (nameError) setNameError(null)
                }}
                wrapClassName="plib__name"
              />
              {draft.id === null ? (
                <Badge tone="accent">Not saved yet</Badge>
              ) : dirty ? (
                <Badge tone="warning" dot>
                  Unsaved
                </Badge>
              ) : null}
            </div>
            <TextArea
              label="System prompt"
              hint="Sent to the AI as the chat’s instructions. Using it in a chat copies the text, so later edits here don’t change that chat."
              value={draft.body}
              minRows={phone ? 8 : 14}
              maxRows={phone ? 16 : 26}
              maxLength={PROMPT_LIMITS.body}
              showCount
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                  e.preventDefault()
                  void save()
                }
              }}
            />
            <div className="plib__actions">
              <Button variant="primary" loading={busy === 'save'} disabled={!dirty} onClick={() => void save()}>
                Save
              </Button>
              {draft.id !== null ? (
                <Button icon={<Copy />} onClick={() => startNew({ name: draft.name, body: draft.body })}>
                  Duplicate
                </Button>
              ) : null}
              <span className="plib__spacer" />
              <IconButton
                label={draft.id === null ? 'Discard this prompt' : 'Delete this prompt'}
                icon={<Trash2 />}
                variant="danger"
                loading={busy === 'delete'}
                onClick={() => void remove()}
              />
            </div>
            {draft.id !== null && current ? <UseInChat prompt={current} disabled={dirty} /> : null}
          </section>
        ) : !phone ? (
          <section className="plib__editor plib__editor--empty" aria-label="Prompt editor">
            <EmptyState size="sm" icon={<BookText />} title="Pick a prompt or make a new one" headingLevel={2} />
          </section>
        ) : null}
      </div>
      {dialog}
    </div>
  )
}

function UseInChat({ prompt, disabled }: { prompt: Prompt; disabled: boolean }): ReactNode {
  const { data } = useLive(manifest)
  const [pick, setPick] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const sessions = useMemo(
    () =>
      [...(data?.sessions ?? [])]
        .filter((s) => !s.archived)
        .sort(byActivity)
        .slice(0, 200),
    [data]
  )
  const use = async (): Promise<void> => {
    if (!pick) return
    setBusy(true)
    try {
      await applyPromptToSession(pick, prompt)
      const s = sessions.find((x) => x.uid === pick)
      toast.success(`${s ? formatShortId(s.shortId) : 'The chat'} now uses “${prompt.name}”.`, {
        action: { label: 'Open chat', onClick: () => navigate(`/s/${pick}`) }
      })
      setPick(null)
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="plib__use">
      <MessageSquare aria-hidden="true" className="plib__use-icon" />
      <Combobox
        label="Use in a chat"
        size="sm"
        placeholder="Choose a chat…"
        value={pick}
        onChange={setPick}
        disabled={disabled}
        hint={disabled ? 'Save your changes first.' : `${formatCount(prompt.body.length)} characters. The chat gets a copy of the text.`}
        options={sessions.map((s) => ({ value: s.uid, label: s.title || 'New chat', description: formatShortId(s.shortId), keywords: [s.shortId] }))}
        wrapClassName="plib__use-pick"
      />
      <Button size="sm" variant="primary" disabled={!pick || disabled} loading={busy} onClick={() => void use()}>
        Use
      </Button>
    </div>
  )
}
