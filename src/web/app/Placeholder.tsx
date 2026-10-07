/** A calm "not built yet" panel for registry entries whose owners arrive in later phases. */
import type { ReactNode } from 'react'
import { StarGlyph } from './StarGlyph'
import './placeholder.css'

export function Placeholder({ title, children }: { title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="placeholder">
      <StarGlyph size={36} />
      <h1 className="placeholder__title">{title}</h1>
      <p className="placeholder__text">{children ?? 'This part of Vesper is still being built.'}</p>
    </div>
  )
}
