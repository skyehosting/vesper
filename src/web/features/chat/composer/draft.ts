/**
 * Draft cleanup wiring (F09/F17): a chat's draft is dropped when the chat is deleted or ends anywhere
 * (`session.deleted`/`session.ended`), and stored drafts of chats that are gone are swept once per start. The storage
 * rules live in draft.logic.ts.
 */
import { api } from '../../../lib/api'
import { ws } from '../../../lib/ws'
import { clearDraft, sweepDrafts } from './draft.logic'

export { clearAllDrafts, clearDraft, loadDraft, saveDraft, type DraftKind } from './draft.logic'

/** Pages through the chat list (ordinary and archived; Trash counts as gone). At most 20 pages of 200 per filter. */
async function listAllChats(): Promise<Map<string, boolean> | null> {
  const out = new Map<string, boolean>()
  try {
    for (const filter of ['all', 'archived'] as const) {
      let cursor: string | undefined
      for (let page = 0; ; page++) {
        if (page >= 20) return null
        const r = await api('GET /api/sessions', { query: { filter, limit: 200, ...(cursor ? { cursor } : {}) } })
        for (const s of r.items) if (!s.deletedUtc) out.set(s.uid, s.temporary)
        if (!r.next) break
        cursor = r.next
      }
    }
    return out
  } catch {
    return null
  }
}

let installed = false

/** App-lifetime wiring (boot): drop drafts of deleted/ended chats; sweep once the first connection is ready. */
export function installDraftCleanup(): void {
  if (installed) return
  installed = true
  ws.on('session.deleted', (m) => clearDraft(m.sessionUid))
  ws.on('session.ended', (m) => clearDraft(m.sessionUid))
  let swept = false
  ws.onStatus((info) => {
    if (info.status !== 'ready' || swept) return
    swept = true
    void sweepDrafts(listAllChats)
  })
}
