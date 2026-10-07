/**
 * <StarHost> — frozen signature (07 E4, D5); mounted once by App while signed in. It waits for the first paint and an
 * idle moment (07 D7: the Star never delays the chat), then loads the presence host chunk; three.js loads only if a
 * WebGL style or the Constellation needs it. Unmounting it (sign-out) is the "real teardown": everything is released.
 */
import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'

const PresenceHost = lazy(() => import('./host/PresenceHost'))

export function StarHost(): ReactNode {
  const [go, setGo] = useState(false)

  useEffect(() => {
    let idle = 0
    let timer = 0
    const raf = requestAnimationFrame(() => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(() => setGo(true), { timeout: 1200 })
      else timer = window.setTimeout(() => setGo(true), 200)
    })
    return () => {
      cancelAnimationFrame(raf)
      if (idle) window.cancelIdleCallback(idle)
      if (timer) window.clearTimeout(timer)
    }
  }, [])

  return go ? (
    <Suspense fallback={null}>
      <PresenceHost />
    </Suspense>
  ) : null
}
