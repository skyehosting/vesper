/**
 * Talk mode's entries (top bar, Ctrl+K, /talk; second pass of review F51): like the voice-reply toggle, they check
 * first. With voice input off, Talk mode would only open into an error, so the entry says what is missing instead —
 * with "Set up voice input" in the desktop app, and where to do it everywhere else.
 */
import { toast } from '../../../components/Toast'
import { navigate } from '../../../lib/router'
import { useStore } from '../../../lib/store'
import { talkEntry } from './talk.logic'

export function openTalkMode(sessionUid: string): void {
  const st = useStore.getState()
  const blocked = talkEntry(st.settings, st.bootstrap?.desktop ?? false)
  if (!blocked) {
    navigate(`/talk/${sessionUid}`)
    return
  }
  toast.info(blocked.message, {
    id: 'talk-needs-voice-in',
    ...(blocked.setup ? { action: { label: 'Set up voice input', onClick: () => navigate('/settings/voice-in') } } : {})
  })
}
