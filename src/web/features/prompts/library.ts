/**
 * The prompt library (R11): shared live list (refetched on `prompts.changed` from any device) and the actions the
 * session panel and `/prompt` use. For sessions-ui's panel:
 *
 *   const { prompts } = usePrompts()
 *   await applyPromptToSession(sessionUid, prompt)   // sets the chat's system prompt + library link
 *   await savePrompt(name, body)                       // creates, or updates the entry with that name
 *
 * The chat's own prompt is a copy: editing the library later doesn't change chats already using it (the server keeps
 * the text per session; deleting an entry only clears the link).
 */
import type { Prompt, Session } from '@shared/types/domain'
import type { ApiError } from '@shared/errors'
import { api } from '../../lib/api'
import { createLive, useLive } from '../memory/live'
import { patchSession } from '../sessions/data'
import { filterPrompts, findPrompt, PROMPT_LIMITS, uniqueName } from './library.logic'

export { filterPrompts, findPrompt, PROMPT_LIMITS, uniqueName }

export const promptsLive = createLive<Prompt[]>({
  name: 'prompts',
  load: () => api('GET /api/prompts'),
  refetchOn: ['prompts.changed']
})

export function usePrompts(): { prompts: Prompt[] | null; error: ApiError | null; loading: boolean; reload: () => Promise<void> } {
  const st = useLive(promptsLive)
  return { prompts: st.data, error: st.error, loading: st.loading, reload: st.reload }
}

/** Create, or update the body of the entry with the same name. */
export async function savePrompt(name: string, body: string): Promise<Prompt> {
  const list = promptsLive.get().data ?? (await api('GET /api/prompts'))
  const existing = findPrompt(list, name)
  const p = existing
    ? await api('PATCH /api/prompts/:id', { params: { id: existing.id }, body: { body } })
    : await api('POST /api/prompts', { body: { name, body } })
  void promptsLive.reload()
  return p
}

/** Use a library prompt in a chat (its text becomes the chat's system prompt; applied as a system note, 07 C1). */
// Through sessions-ui's patchSession: the open chat (panel, header badges) shows the change at once.
export async function applyPromptToSession(sessionUid: string, p: Prompt): Promise<Session> {
  return patchSession(sessionUid, { systemPrompt: p.body, promptId: p.id })
}

export async function clearSessionPrompt(sessionUid: string): Promise<Session> {
  return patchSession(sessionUid, { systemPrompt: '', promptId: null })
}
