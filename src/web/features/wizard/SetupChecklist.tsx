/**
 * The setup checklist (07 D13): the wizard steps the owner skipped, shown in the first chat's empty state, each
 * ticked once it is set up (in Settings or elsewhere). chat-ui renders `<SetupChecklist />` in its empty state; it
 * renders nothing when nothing is left, when it was dismissed, or on devices other than the desktop.
 */
import type { ReactNode } from 'react'
import { ChevronRight, CircleCheck, Circle, X } from 'lucide-react'
import { IconButton } from '../../components/IconButton'
import { Link } from '../../lib/router'
import { useStore } from '../../lib/store'
import { setSetting } from '../settings/save'
import { checklistItems, checklistOpen } from './wizard.logic'
import './checklist.css'

export function SetupChecklist(): ReactNode {
  const settings = useStore((s) => s.settings)
  const desktop = useStore((s) => s.bootstrap?.desktop ?? false)
  if (!settings || !desktop) return null
  const items = checklistItems(settings)
  if (!checklistOpen(items)) return null
  const left = items.filter((i) => !i.done).length
  return (
    <section className="checklist" aria-labelledby="checklist-title">
      <div className="checklist__head">
        <div>
          <h2 className="checklist__title" id="checklist-title">
            Finish setting up
          </h2>
          <p className="checklist__sub">
            {left} {left === 1 ? 'thing' : 'things'} you skipped — whenever you like.
          </p>
        </div>
        <IconButton size="sm" label="Hide the setup checklist" icon={<X />} onClick={() => setSetting('wizard.checklistDismissed', true, { immediate: true })} />
      </div>
      <ul className="checklist__items">
        {items.map((i) => (
          <li key={i.id} className={`checklist__item${i.done ? ' is-done' : ''}`}>
            <Link to={`/settings/${i.section}`} className="checklist__link">
              {i.done ? <CircleCheck className="checklist__mark" aria-hidden="true" /> : <Circle className="checklist__mark" aria-hidden="true" />}
              <span className="checklist__text">
                <span className="checklist__item-title">
                  {i.title}
                  {i.done ? <span className="sr-only"> (done)</span> : null}
                </span>
                <span className="checklist__item-desc">{i.description}</span>
              </span>
              <ChevronRight className="checklist__chev" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
