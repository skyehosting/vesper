/** Vesper's static star mark (brand, AI avatar, Star placeholder). Pure SVG — never a WebGL context (07 D5). */
import type { ReactNode } from 'react'

export function StarGlyph({ size = 18, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="vesper-star-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="12" cy="12" r="11" fill="url(#vesper-star-glow)" />
      <path
        d="M12 2.5c.5 4.9 2.6 7 7.5 7.5v.01c-4.9.5-7 2.6-7.5 7.49h-.01c-.5-4.9-2.6-7-7.49-7.5V10c4.9-.5 7-2.6 7.5-7.5z"
        transform="translate(0 2)"
        fill="var(--accent)"
      />
    </svg>
  )
}
