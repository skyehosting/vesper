/**
 * The prompt library inside a chat — the ONE picker (the session panel embeds it, R11): a "Library" menu that applies
 * a saved prompt to the chat, saves the chat's current prompt to the library (`onSaved` lets the panel link the chat
 * to the new entry), or opens /prompts ("Manage the library").
 *
 *   <PromptPicker sessionUid={uid} currentPrompt={session.systemPrompt} currentPromptId={session.promptId} />
 */
import type { Prompt } from '@shared/types/domain'
import { useState, type ReactNode } from 'react'
import { BookText, Check, ChevronDown, Library, Save } from 'lucide-react'
import { Button } from '../../components/Button'
import { Dialog } from '../../components/Dialog'
import { Menu, type MenuItem } from '../../components/Menu'
import { TextField } from '../../components/TextField'
import { toast } from '../../components/Toast'
import { toApiError } from '../../lib/errors.logic'
import { navigate } from '../../lib/router'
import { errorText } from '../memory/format.logic'
import { applyPromptToSession, filterPrompts, PROMPT_LIMITS, savePrompt, usePrompts } from './library'

export function PromptPicker({
  sessionUid,
  currentPrompt,
  currentPromptId,
  onApplied,
  onSaved
}: {
  sessionUid: string
  currentPrompt: string
  currentPromptId: number | null
  onApplied?: () => void
  /** The current prompt was saved to the library as `p`. */
  onSaved?: (p: Prompt) => void
}): ReactNode {
  const { prompts } = usePrompts()
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const items: MenuItem[] = [
    ...(prompts && prompts.length
      ? filterPrompts(prompts, '')
          .slice(0, 30)
          .map<MenuItem>((p) => ({
            id: `p${p.id}`,
            label: p.name,
            icon: p.id === currentPromptId ? <Check /> : <BookText />,
            description: p.body.trim().split('\n')[0]?.slice(0, 80),
            onSelect: () =>
              void applyPromptToSession(sessionUid, p).then(
                () => {
                  toast.success(`This chat now uses “${p.name}”.`)
                  onApplied?.()
                },
                (e: unknown) => toast.error(toApiError(e).message)
              )
          }))
      : [{ kind: 'label' as const, id: 'empty', label: 'No saved prompts yet' }]),
    { kind: 'separator', id: 'sep' },
    {
      id: 'save',
      label: 'Save this prompt to the library…',
      icon: <Save />,
      disabled: !currentPrompt.trim(),
      onSelect: () => (setName(''), setErr(null), setSaving(true))
    },
    { id: 'manage', label: 'Manage the library', icon: <Library />, onSelect: () => navigate('/prompts') }
  ]

  const save = async (): Promise<void> => {
    const n = name.trim()
    if (!n) {
      setErr('Give it a name.')
      return
    }
    setBusy(true)
    try {
      const p = await savePrompt(n, currentPrompt)
      toast.success(`Saved to the library as “${p.name}”.`)
      setSaving(false)
      onSaved?.(p)
    } catch (e) {
      setErr(errorText(toApiError(e)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Menu
        aria-label="Prompt library"
        items={items}
        trigger={
          <Button size="sm" icon={<Library />} iconRight={<ChevronDown />}>
            Library
          </Button>
        }
      />
      <Dialog
        open={saving}
        onClose={() => !busy && setSaving(false)}
        title="Save to the prompt library"
        description="An entry with the same name is updated."
        size="sm"
        footer={
          <>
            <Button onClick={() => setSaving(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>
              Save
            </Button>
          </>
        }
      >
        <TextField
          label="Name"
          value={name}
          maxLength={PROMPT_LIMITS.name}
          error={err ?? undefined}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      </Dialog>
    </>
  )
}
