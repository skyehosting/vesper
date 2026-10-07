/** Gallery building blocks: a titled section (stable `data-testid="gallery-<id>"` for screenshots) and a labelled demo. */
import type { ReactNode } from 'react'

export interface SectionDef {
  id: string
  title: string
}

export function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="g-section" id={`gallery-${id}`} data-testid={`gallery-${id}`} aria-labelledby={`gallery-${id}-title`}>
      <header className="g-section__head">
        <h2 id={`gallery-${id}-title`}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </header>
      <div className="g-section__body">{children}</div>
    </section>
  )
}

export function Demo({ label, children, wide = false, testId }: { label: string; children: ReactNode; wide?: boolean; testId?: string }): ReactNode {
  return (
    <div className={wide ? 'g-demo g-demo--wide' : 'g-demo'} data-testid={testId}>
      <h3 className="g-demo__label">{label}</h3>
      <div className="g-demo__body">{children}</div>
    </div>
  )
}

export function Row({ children }: { children: ReactNode }): ReactNode {
  return <div className="g-row">{children}</div>
}

export function Stack({ children, gap = 14 }: { children: ReactNode; gap?: number }): ReactNode {
  return (
    <div className="g-stack" style={{ gap }}>
      {children}
    </div>
  )
}
