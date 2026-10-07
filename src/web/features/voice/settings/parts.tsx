/** Layout pieces for the voice settings pages and wizard steps (built on the kit; tokens only). */
import { useId, type ReactNode } from 'react'
import { Callout } from '../../../components/Callout'
import { Segmented, type SegmentedOption } from '../../../components/Segmented'
import { cx } from '../../../components/internal/cx'
import { disclosure, type Disclosure } from '@shared/privacy'

export function PageHead({ title, lead, children }: { title: string; lead: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <header className="vs-head">
      <div className="vs-head__text">
        <h1 className="vs-head__title">{title}</h1>
        <p className="vs-head__lead">{lead}</p>
      </div>
      {children ? <div className="vs-head__aside">{children}</div> : null}
    </header>
  )
}

export function Section({ title, description, children, id, className }: { title: string; description?: ReactNode; children: ReactNode; id?: string; className?: string }): ReactNode {
  const hid = useId()
  return (
    <section className={cx('vs-section', className)} aria-labelledby={hid} id={id}>
      <div className="vs-section__head">
        <h2 className="vs-section__title" id={hid}>
          {title}
        </h2>
        {description ? <p className="vs-section__desc">{description}</p> : null}
      </div>
      <div className="vs-section__body">{children}</div>
    </section>
  )
}

/** A Segmented control with a visible label and hint (the kit's Segmented takes aria-labelledby only). */
export function LabeledSegmented<V extends string>({
  label,
  hint,
  value,
  onChange,
  options,
  disabled,
  id,
  block
}: {
  label: ReactNode
  hint?: ReactNode
  value: V
  onChange: (v: V) => void
  options: readonly SegmentedOption<V>[]
  disabled?: boolean
  id?: string
  block?: boolean
}): ReactNode {
  const auto = useId()
  const lid = `${id ?? auto}-label`
  const hid = `${id ?? auto}-hint`
  return (
    <div className="vs-seg" id={id}>
      <span className="field-label" id={lid}>
        {label}
      </span>
      <Segmented aria-labelledby={lid} value={value} onChange={onChange} options={options} disabled={disabled} block={block} />
      {hint ? (
        <p className="field-hint" id={hid}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

/** Just-in-time privacy text for a service (07 B13, src/shared/privacy.ts): by id, or a computed disclosure. */
export function PrivacyNote({ id, disclosure: given, compact }: { id?: string; disclosure?: Disclosure; compact?: boolean }): ReactNode {
  const d = given ?? (id ? disclosure(id) : undefined)
  if (!d) return null
  const local = d.training === 'local'
  return (
    <Callout
      tone={local ? 'success' : 'privacy'}
      title={local ? 'Stays on this PC' : `What ${d.service} receives`}
      learnMore={d.sources[0] ? { label: 'Their privacy terms', href: d.sources[0] } : undefined}
      className={cx('vs-privacy', compact && 'is-compact')}
    >
      {compact && !local ? d.sends : d.summary}
      {!compact && !local && d.verified ? <span className="vs-privacy__verified"> Checked {d.verified}.</span> : null}
    </Callout>
  )
}

/** Shown to remote devices for settings only the PC may change (07 B2). */
export function DesktopOnlyNote({ what }: { what: string }): ReactNode {
  return (
    <Callout tone="info" title="Change this on your PC">
      {what} can only be changed in Vesper on the PC it runs on.
    </Callout>
  )
}
