/**
 * The frame shared by the sign-in, pairing and waiting screens: a night-sky backdrop and one centred card (full
 * width on phones, safe areas respected, 07 D8).
 */
import type { ReactNode } from 'react'
import { StarGlyph } from '../../app/StarGlyph'
import './login.css'

export function AuthLayout({
  title,
  lead,
  children,
  footer,
  glyph = 'star',
  busy = false
}: {
  title: ReactNode
  lead?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** The mark above the title: the star, a waiting star (pulsing ring) or none. */
  glyph?: 'star' | 'waiting' | ReactNode
  busy?: boolean
}): ReactNode {
  return (
    <main className="login" aria-busy={busy || undefined}>
      <div className="login__sky" aria-hidden="true" />
      <section className="login__card" aria-labelledby="login-title">
        <div className={glyph === 'waiting' ? 'login__mark login__mark--waiting' : 'login__mark'} aria-hidden="true">
          {glyph === 'star' || glyph === 'waiting' ? <StarGlyph size={52} /> : glyph}
        </div>
        <h1 id="login-title" className="login__title">
          {title}
        </h1>
        {lead ? <p className="login__lead">{lead}</p> : null}
        {children}
      </section>
      {footer ? <div className="login__footer">{footer}</div> : null}
    </main>
  )
}
