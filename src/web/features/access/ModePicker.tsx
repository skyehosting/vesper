/**
 * Where Vesper can be used (R1; 07 D8): This PC only (default) / Local network / Anywhere with Tailscale, as radio
 * cards, plus the capability matrix of what works on phones in each mode. The choice is a draft until applied, so
 * arrowing through the cards never restarts listeners.
 */
import type { ReactNode } from 'react'
import { Check, Globe, Minus, Monitor, Wifi, X } from 'lucide-react'
import type { AccessMode } from '@shared/types/domain'
import { Badge } from '../../components/Badge'
import { RadioGroup, type RadioOption } from '../../components/RadioGroup'
import { CAPABILITIES, capText, MODES, type Cap } from './access.logic'

const ICONS: Record<AccessMode, ReactNode> = { local: <Monitor />, lan: <Wifi />, tailscale: <Globe /> }

export function ModePicker({
  value,
  current,
  onChange,
  portable,
  disabled,
  label = 'Where you can use Vesper'
}: {
  value: AccessMode
  /** The mode that is live now (gets a "Current" badge). */
  current?: AccessMode | null
  onChange: (m: AccessMode) => void
  portable?: boolean
  disabled?: boolean
  label?: string
}): ReactNode {
  const options: RadioOption<AccessMode>[] = MODES.map((m) => ({
    value: m.id,
    label: m.title,
    icon: ICONS[m.id],
    description: (
      <>
        {m.summary}
        <span className="acc-mode__needs">{portable && m.id === 'lan' ? 'Needs the installed version of Vesper' : m.needs}</span>
      </>
    ),
    badge:
      current === m.id ? (
        <Badge tone="accent" size="sm">
          Current
        </Badge>
      ) : m.id === 'local' ? (
        <Badge size="sm">Default</Badge>
      ) : undefined,
    disabled: portable && m.id === 'lan'
  }))
  return <RadioGroup className="acc-mode" variant="cards" columns={3} label={label} labelHidden value={value} onChange={onChange} options={options} disabled={disabled} />
}

function CapIcon({ cap }: { cap: Cap }): ReactNode {
  return (
    <span className={`acc-cap acc-cap--${cap}`} aria-hidden="true">
      {cap === 'yes' ? <Check /> : cap === 'no' ? <X /> : <Minus />}
    </span>
  )
}

/** What works where (07 D8). The selected mode's column is highlighted. */
export function CapabilityMatrix({ selected }: { selected: AccessMode }): ReactNode {
  return (
    <div className="acc-matrix-wrap">
      <table className="acc-matrix">
        <caption className="sr-only">What works in each access mode</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className="sr-only">Feature</span>
            </th>
            {MODES.map((m) => (
              <th key={m.id} scope="col" className={m.id === selected ? 'is-selected' : undefined} aria-current={m.id === selected ? 'true' : undefined}>
                <span className="acc-matrix__long">{m.id === 'local' ? 'This PC' : m.id === 'lan' ? 'Local network' : 'Tailscale'}</span>
                <span className="acc-matrix__short">{m.short}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CAPABILITIES.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              {MODES.map((m) => {
                const c = row.cells[m.id]
                return (
                  <td key={m.id} className={m.id === selected ? 'is-selected' : undefined}>
                    <span className="acc-matrix__cell">
                      <CapIcon cap={c.cap} />
                      <span className={c.note ? 'acc-matrix__note' : 'sr-only'}>{c.note ?? capText(c.cap)}</span>
                      {c.note ? <span className="sr-only"> ({capText(c.cap)})</span> : null}
                    </span>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
