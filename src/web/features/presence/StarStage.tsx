/**
 * A stage target that fills its box (Talk mode's big stage): like <Star>, but sized by CSS instead of a fixed pixel
 * size, and registered with the `stage` priority so the one surface moves here from the compact stage (07 D5).
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { StarGlyph } from '../../app/StarGlyph'
import { registerTarget, type TargetKind } from './targets'
import './star.css'

export function StarStage({ kind = 'stage', className }: { kind?: Extract<TargetKind, 'stage' | 'header' | 'custom'>; className?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    return registerTarget(el, kind)
  }, [kind])
  return (
    <div ref={ref} className={['star-slot', 'star-slot--fill', className].filter(Boolean).join(' ')} aria-hidden="true">
      <span className="star-slot__fallback">
        <StarGlyph size={96} />
      </span>
    </div>
  )
}
