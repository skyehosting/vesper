/**
 * Memory viewer → About you (07 A4 pinned facts): short facts the AI always keeps in mind, delivered at the start of
 * each conversation and whenever they change. `/remember <fact>` in a chat lands here. Add, edit in place, delete
 * with undo. Facts are one line, ≤ 500 characters (server rule, memory/facts.ts).
 */
import { useRef, useState, type ReactNode } from 'react'
import { Check, Pencil, Pin, Plus, Trash2, X } from 'lucide-react'
import type { Fact } from '@shared/types/domain'
import { relativeAge } from '@shared/time'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { ErrorState } from '../../components/ErrorState'
import { IconButton } from '../../components/IconButton'
import { Kbd } from '../../components/Kbd'
import { Skeleton } from '../../components/Skeleton'
import { TextField } from '../../components/TextField'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'
import { useLive } from './live'
import { facts } from './stores'
import { errorText } from './format.logic'
import { useViewerZone } from './zone'

export const MAX_FACT_CHARS = 500

export function FactsView(): ReactNode {
  const { data, error, reload } = useLive(facts)
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const add = async (): Promise<void> => {
    const t = text.trim()
    if (!t) {
      setAddError('Write the fact to remember.')
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const f = await api('POST /api/facts', { body: { text: t } })
      facts.set([...(facts.get().data ?? []), f])
      setText('')
      inputRef.current?.focus()
    } catch (e) {
      setAddError(errorText(toApiError(e)))
    } finally {
      setAdding(false)
    }
  }

  const remove = async (f: Fact): Promise<void> => {
    try {
      await api('DELETE /api/facts/:id', { params: { id: f.id } })
    } catch (e) {
      toast.error(toApiError(e).message)
      return
    }
    facts.set((facts.get().data ?? []).filter((x) => x.id !== f.id))
    toast.info('Fact removed.', {
      action: {
        label: 'Undo',
        onClick: () =>
          void api('POST /api/facts', { body: { text: f.text } }).then(
            () => void reload(),
            (e: unknown) => toast.error(toApiError(e).message)
          )
      }
    })
  }

  return (
    <div className="mfacts">
      <p className="mfacts__intro">
        The AI keeps these in mind in every chat — your name for things, people and pets, preferences, what you’re working on. In any chat, type{' '}
        <Kbd>/remember</Kbd> followed by a fact to add one.
      </p>
      <form
        className="mfacts__add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <TextField
          ref={inputRef}
          label="New fact"
          labelHidden
          placeholder="e.g. My sister Ana lives in Porto"
          value={text}
          maxLength={MAX_FACT_CHARS}
          error={addError ?? undefined}
          onChange={(e) => {
            setText(e.target.value)
            if (addError) setAddError(null)
          }}
          wrapClassName="mfacts__field"
        />
        <Button type="submit" variant="primary" icon={<Plus />} loading={adding}>
          Add
        </Button>
      </form>
      {error && !data ? (
        <ErrorState error={error} onRetry={() => void reload()} />
      ) : !data ? (
        <div data-loading>
          <Skeleton lines={3} />
        </div>
      ) : data.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<Pin />}
          title="Nothing pinned yet"
          description="Facts you add here are given to the AI at the start of every conversation."
        />
      ) : (
        <ul className="mfacts__list" aria-label="Pinned facts">
          {data.map((f) => (
            <FactRow key={f.id} f={f} onRemove={() => void remove(f)} />
          ))}
        </ul>
      )}
    </div>
  )
}

function FactRow({ f, onRemove }: { f: Fact; onRemove: () => void }): ReactNode {
  const { zone } = useViewerZone()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(f.text)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const editRef = useRef<HTMLButtonElement>(null)

  const save = async (): Promise<void> => {
    const t = text.trim()
    if (t === f.text) {
      setEditing(false)
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const next = await api('PATCH /api/facts/:id', { params: { id: f.id }, body: { text: t } })
      facts.set((facts.get().data ?? []).map((x) => (x.id === f.id ? next : x)))
      setEditing(false)
      requestAnimationFrame(() => editRef.current?.focus())
    } catch (e) {
      setErr(errorText(toApiError(e)))
    } finally {
      setBusy(false)
    }
  }

  const when =
    f.updatedUtc > f.createdUtc + 1000 ? `edited ${relativeAge(f.updatedUtc, Date.now(), zone)}` : `added ${relativeAge(f.createdUtc, Date.now(), zone)}`
  return (
    <li className="mfact" data-testid="fact">
      {editing ? (
        <form
          className="mfact__edit"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <TextField
            label="Edit fact"
            labelHidden
            autoFocus
            value={text}
            maxLength={MAX_FACT_CHARS}
            error={err ?? undefined}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setText(f.text)
                setEditing(false)
              }
            }}
            wrapClassName="mfact__field"
          />
          <IconButton type="submit" label="Save fact" icon={<Check />} variant="primary" loading={busy} />
          <IconButton label="Cancel editing" icon={<X />} onClick={() => (setText(f.text), setEditing(false))} />
        </form>
      ) : (
        <>
          <Pin className="mfact__pin" aria-hidden="true" />
          <div className="mfact__text">
            <p>{f.text}</p>
            <span className="mfact__when">{when}</span>
          </div>
          <span className="mfact__actions">
            <IconButton ref={editRef} size="sm" label={`Edit “${f.text.slice(0, 40)}”`} icon={<Pencil />} onClick={() => setEditing(true)} />
            <IconButton size="sm" label={`Remove “${f.text.slice(0, 40)}”`} icon={<Trash2 />} onClick={onRemove} />
          </span>
        </>
      )}
    </li>
  )
}
