/** '/' → the last session opened on this device, else the most recent one, else a fresh chat. */
import { useEffect, useRef, type ReactNode } from 'react'
import { createSession, lastSessionUid, loadSessions } from '../features/sessions/data'
import { activityOf } from '../features/sessions/group.logic'
import { toast } from '../components/Toast'
import { toApiError } from '../lib/errors.logic'
import { navigate } from '../lib/router'
import { useStore } from '../lib/store'

export function HomeRedirect(): ReactNode {
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      let { sessions } = useStore.getState()
      if (!sessions.loaded || sessions.query) {
        await loadSessions('')
        sessions = useStore.getState().sessions
      }
      const last = lastSessionUid()
      const known = last && sessions.items.some((s) => s.uid === last) ? last : null
      const recent = [...sessions.items].sort((a, b) => activityOf(b) - activityOf(a))[0]?.uid ?? null
      const target = known ?? recent
      if (target) {
        navigate(`/s/${target}`, { replace: true })
        return
      }
      if (sessions.error) return // the sidebar shows the error; don't create sessions blindly
      try {
        const s = await createSession()
        navigate(`/s/${s.uid}`, { replace: true })
      } catch (e) {
        toast.error(toApiError(e).message)
      }
    })()
  }, [])
  return <div data-loading hidden />
}
