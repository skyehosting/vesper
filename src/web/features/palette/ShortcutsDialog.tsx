/**
 * The "?" / Ctrl+/ sheet: every registered keyboard shortcut by group, and every slash command from the registry
 * (what /help lists). Opened with `actions.showShortcuts()`; /help can open it on the Commands tab with
 * `actions.openHelp('commands')` (features/palette/actions.ts).
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Dialog } from '../../components/Dialog'
import { Kbd } from '../../components/Kbd'
import { Segmented } from '../../components/Segmented'
import { commands } from '../../lib/commands/registry'
import { useStore } from '../../lib/store'
import { paletteContext } from './context'
import { listShortcuts, onShortcutsChanged, helpTabNow, setHelpTab, type Shortcut, type ShortcutGroup } from './shortcuts'
import './palette.css'

const GROUPS: ShortcutGroup[] = ['General', 'Chats', 'In a chat', 'Chat list']
let snapshot: Shortcut[] = listShortcuts()
const sub = (cb: () => void): (() => void) =>
  onShortcutsChanged(() => {
    snapshot = listShortcuts()
    cb()
  })
const get = (): Shortcut[] => snapshot

export default function ShortcutsDialog(): ReactNode {
  const close = (): void => useStore.getState().setShortcutsOpen(false)
  const [tab, setTab] = useState<'keys' | 'commands'>(helpTabNow)
  useEffect(() => () => setHelpTab('keys'), [])
  const all = useSyncExternalStore(sub, get, get)
  const cmds = commands.list(paletteContext())

  return (
    <Dialog open onClose={close} title="Keyboard & commands" size="lg">
      <Segmented<'keys' | 'commands'>
        className="keys-tabs"
        aria-label="Show"
        size="sm"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'keys', label: 'Keyboard shortcuts' },
          { value: 'commands', label: 'Slash commands' }
        ]}
      />
      {tab === 'keys' ? (
        <div className="keys-groups">
          {GROUPS.map((g) => {
            const list = all.filter((s) => s.group === g)
            if (!list.length) return null
            return (
              <section key={g} className="keys-group" aria-labelledby={`kg-${g}`}>
                <h3 id={`kg-${g}`}>{g}</h3>
                <dl>
                  {list.map((s) => (
                    <div key={s.id} className="keys-row">
                      <dt>{s.label}</dt>
                      <dd>
                        {[s.keys, ...(s.alt ?? [])].map((k) => (
                          <Kbd key={k} keys={k} />
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )
          })}
        </div>
      ) : (
        <>
          <p className="keys-note">
            Type these in the message box or in the Ctrl+K palette. Chat IDs look like #K7Q2MX (copy one from the chat’s title bar).
          </p>
          <dl className="keys-cmds">
            {cmds.map((c) => (
              <div key={c.name} style={{ display: 'contents' }}>
                <dt>
                  /{c.name}
                  {c.args ? ` ${c.args}` : ''}
                </dt>
                <dd>{c.help}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </Dialog>
  )
}
