/**
 * <Star> — frozen signature (07 E4, BLD-4). A Star is a *layout target*: the one persistent presence surface (the
 * WebGL canvas or the 2D star, owned by <StarHost>, 07 D5) moves into the winning target, so mounting many Stars never
 * creates contexts. Until the surface arrives (or while it lives in another target) the slot shows the static glyph.
 * The canvas is aria-hidden; the slot carries the state as text (07 D9).
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { StarGlyph } from '../../app/StarGlyph'
import { useStore, type StarState } from '../../lib/store'
import { STAR_STATE_TEXT } from './state.logic'
import { registerTarget, type TargetKind } from './targets'
import './star.css'

export interface StarProps {
  /** compact = chat stage, stage = Talk mode, header = phone header; or a pixel size. */
  size?: 'compact' | 'stage' | 'header' | number
  /** Override the store's state (galleries, previews, the wizard finale). */
  state?: StarState
  className?: string
}

const PX = { compact: 96, stage: 280, header: 40 } as const

export function Star({ size = 'compact', state, className }: StarProps): ReactNode {
  const current = useStore((s) => s.presence.star)
  const ref = useRef<HTMLDivElement>(null)
  const px = typeof size === 'number' ? size : PX[size]
  const kind: TargetKind = typeof size === 'number' ? 'custom' : size

  useEffect(() => {
    const el = ref.current
    if (!el) return
    return registerTarget(el, kind)
  }, [kind])

  const shown = state ?? current
  return (
    <div
      ref={ref}
      className={['star-slot', `star-slot--${kind}`, className].filter(Boolean).join(' ')}
      data-state={shown}
      data-star-state={state}
      style={{ width: px, height: px }}
    >
      <span className="star-slot__fallback" aria-hidden="true">
        <StarGlyph size={Math.round(px * 0.62)} />
      </span>
      <span className="sr-only">Vesper: {STAR_STATE_TEXT[shown]}</span>
    </div>
  )
}
