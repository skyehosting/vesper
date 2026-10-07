/**
 * The chat's system prompt (R11): edit inline (Save / Revert; Ctrl+Enter saves) or clear it; the prompt library is
 * memory-ui's one PromptPicker (apply a saved prompt, save this chat's prompt to the library, "Manage the library"
 * → /prompts). A change reaches the AI as a note before its next reply (07 C1: the frozen system prompt is never
 * rewritten).
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Eraser, Save, Undo2 } from 'lucide-react'
import type { Session } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { TextArea } from '../../components/TextArea'
import { PromptPicker, usePrompts } from '../prompts'
import { trySession } from '../sessions/data'

export const PROMPT_MAX = 100_000

export function PromptSection({ session }: { session: Session }): ReactNode {
  const [draft, setDraft] = useState(session.systemPrompt)
  const [saving, setSaving] = useState(false)
  const { prompts } = usePrompts()
  const hintId = useId()
  const dirty = draft !== session.systemPrompt

  // Follow changes made elsewhere (the library picker, /prompt, another device) unless the user is mid-edit, i.e. the
  // draft still equals the prompt as it was before this change.
  const shown = useRef(session.systemPrompt)
  useEffect(() => {
    const before = shown.current
    shown.current = session.systemPrompt
    setDraft((d) => (d === before ? session.systemPrompt : d))
  }, [session.systemPrompt])

  const save = async (): Promise<void> => {
    if (!dirty || saving) return
    setSaving(true)
    const match = prompts?.find((p) => p.body === draft)
    await trySession(session.uid, { systemPrompt: draft, promptId: match ? match.id : null }, 'System prompt saved')
    setSaving(false)
  }

  const using = session.promptId !== null ? prompts?.find((p) => p.id === session.promptId) : undefined

  return (
    <div className="psec__body">
      <TextArea
        label="System prompt"
        labelHidden
        value={draft}
        placeholder="How should the AI behave in this chat? E.g. “You are a patient Spanish tutor. Reply in Spanish, then English.”"
        minRows={4}
        maxRows={14}
        maxLength={PROMPT_MAX}
        aria-describedby={hintId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void save()
          } else if (e.key === 'Escape' && dirty) {
            e.preventDefault()
            e.stopPropagation()
            setDraft(session.systemPrompt)
          }
        }}
      />
      <p className="psec__hint" id={hintId}>
        {using ? (
          <>
            From the library: <strong>{using.name}</strong>.{' '}
          </>
        ) : null}
        Changes reach the AI as a note before its next reply.
      </p>
      <div className="psec__row">
        {dirty ? (
          <>
            <Button size="sm" variant="primary" icon={<Save />} loading={saving} onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" icon={<Undo2 />} onClick={() => setDraft(session.systemPrompt)}>
              Revert
            </Button>
          </>
        ) : (
          <>
            <PromptPicker
              sessionUid={session.uid}
              currentPrompt={session.systemPrompt}
              currentPromptId={session.promptId}
              onSaved={(p) => void trySession(session.uid, { promptId: p.id })}
            />
            {session.systemPrompt ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<Eraser />}
                onClick={() => {
                  setDraft('')
                  void trySession(session.uid, { systemPrompt: '', promptId: null }, 'System prompt cleared')
                }}
              >
                Clear
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
