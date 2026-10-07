/** The Star as this device shows it: synced appearance settings + DevicePrefs + device facts (07 D8). */
import { useMemo } from 'react'
import { useStore } from '../../lib/store'
import { useIsPhone, useMediaQuery } from '../../lib/useMediaQuery'
import { resolveStar, type EffectiveStar } from './prefs.logic'

export function useEffectiveStar(): EffectiveStar {
  const star = useStore((s) => s.settings?.appearance.star)
  const appReduce = useStore((s) => s.settings?.appearance.reduceMotion ?? false)
  const prefs = useStore((s) => s.presence.prefs)
  const phone = useIsPhone()
  const osReduce = useMediaQuery('(prefers-reduced-motion: reduce)')
  return useMemo(() => resolveStar(star, prefs, { phone, osReducedMotion: osReduce, appReducedMotion: appReduce }), [star, prefs, phone, osReduce, appReduce])
}
