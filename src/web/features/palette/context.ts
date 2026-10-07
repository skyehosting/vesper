/** The CommandContext for commands run outside the composer (palette, shortcuts sheet). */
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import type { CommandContext } from '../../lib/commands/registry'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { ws } from '../../lib/ws'

/** `setDraft` hands text to the composer: chat-ui listens for the `vesper:set-draft` window event ({detail: {text}}). */
export function paletteContext(): CommandContext {
  return {
    sessionUid: useStore.getState().activeSessionUid,
    navigate,
    api,
    ws,
    toast,
    setDraft: (text) => window.dispatchEvent(new CustomEvent('vesper:set-draft', { detail: { text } }))
  }
}
