/**
 * Disclosure — a button that shows/hides a region ("Advanced", "Show rest" after an interruption, "view summary").
 * Accordion — a stack of disclosures, one open at a time (`type="single"`) or any number.
 *
 *   <Disclosure summary="Advanced">…</Disclosure>
 *   <Accordion type="single" items={[{ value: 'a', title: 'What is sent?', content: … }]} />
 */
import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cx } from './internal/cx'
import './Disclosure.css'

export interface DisclosureProps {
  summary: ReactNode
  children: ReactNode
  /** Uncontrolled initial state. */
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Extra content on the summary row's right (a count, a badge). */
  meta?: ReactNode
  variant?: 'plain' | 'card'
  /** Heading level wrapping the button (accordions in settings); none by default. */
  headingLevel?: 2 | 3 | 4
  className?: string
}

export function Disclosure({ summary, children, defaultOpen = false, open: openProp, onOpenChange, meta, variant = 'plain', headingLevel, className }: DisclosureProps): ReactNode {
  const [openState, setOpenState] = useState(defaultOpen)
  const open = openProp ?? openState
  const id = useId()
  const toggle = (): void => {
    if (openProp === undefined) setOpenState(!open)
    onOpenChange?.(!open)
  }
  const button = (
    <button type="button" className="disclosure__button" aria-expanded={open} aria-controls={`${id}-region`} id={`${id}-button`} onClick={toggle}>
      <ChevronRight className="disclosure__chevron" aria-hidden="true" />
      <span className="disclosure__summary">{summary}</span>
      {meta ? <span className="disclosure__meta">{meta}</span> : null}
    </button>
  )
  const H = headingLevel ? (`h${headingLevel}` as 'h2' | 'h3' | 'h4') : null
  return (
    <div className={cx('disclosure', `disclosure--${variant}`, open && 'is-open', className)}>
      {H ? <H className="disclosure__heading">{button}</H> : button}
      <div className="disclosure__region" id={`${id}-region`} role="region" aria-labelledby={`${id}-button`} hidden={!open}>
        <div className="disclosure__content">{children}</div>
      </div>
    </div>
  )
}

export interface AccordionItem {
  value: string
  title: ReactNode
  content: ReactNode
  meta?: ReactNode
}

export interface AccordionProps {
  items: readonly AccordionItem[]
  type?: 'single' | 'multiple'
  defaultValue?: readonly string[]
  headingLevel?: 2 | 3 | 4
  className?: string
}

export function Accordion({ items, type = 'single', defaultValue = [], headingLevel = 3, className }: AccordionProps): ReactNode {
  const [open, setOpen] = useState<readonly string[]>(defaultValue)
  return (
    <div className={cx('accordion', className)}>
      {items.map((it) => (
        <Disclosure
          key={it.value}
          summary={it.title}
          meta={it.meta}
          headingLevel={headingLevel}
          open={open.includes(it.value)}
          onOpenChange={(o) => setOpen((cur) => (o ? (type === 'single' ? [it.value] : [...cur, it.value]) : cur.filter((v) => v !== it.value)))}
        >
          {it.content}
        </Disclosure>
      ))}
    </div>
  )
}
