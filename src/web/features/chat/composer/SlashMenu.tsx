/**
 * The "/" autocomplete menu above the composer: commands from the registry (07 E1) that match what is typed. The
 * textarea keeps focus (aria-activedescendant); ↑/↓ move, Enter/Tab complete, Esc closes.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { Command } from '../../../lib/commands'

export interface SlashMenuProps {
  id: string
  items: readonly Command[]
  active: number
  onPick(c: Command): void
  onHover(i: number): void
}

export function slashOptionId(menuId: string, i: number): string {
  return `${menuId}-o${i}`
}

export function SlashMenu({ id, items, active, onPick, onHover }: SlashMenuProps): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    box.current?.querySelector(`#${CSS.escape(slashOptionId(id, active))}`)?.scrollIntoView({ block: 'nearest' })
  }, [id, active])
  if (items.length === 0) return null
  return (
    <div
      ref={box}
      className="slash"
      data-reveal-skip=""
      onWheel={(e) => {
        e.currentTarget.scrollTop += e.deltaY
      }}
    >
      <p className="slash__head" aria-hidden="true">
        Commands
      </p>
      <ul id={id} className="slash__list" role="listbox" aria-label="Commands">
        {items.map((c, i) => (
          <li
            key={c.name}
            id={slashOptionId(id, i)}
            role="option"
            aria-selected={i === active}
            className={`slash__item${i === active ? ' is-active' : ''}`}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onPick(c)}
            onPointerMove={() => onHover(i)}
          >
            <span className="slash__name mono">
              /{c.name}
              {c.args ? <span className="slash__args"> {c.args}</span> : null}
            </span>
            <span className="slash__help">{c.help}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
