import { useCallback, useSyncExternalStore } from 'react'

/** Live `matchMedia` result. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    [query]
  )
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}

/** Phone layout breakpoint (04 / 07 D8): below 720 px the sidebar and panel become sheets. */
export const PHONE_QUERY = '(max-width: 719.98px)'

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY)
}
