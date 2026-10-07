/** Gallery: tabs, menus/context menu/popover, dialogs/sheets/confirm, toasts. */
import { useState, type ReactNode } from 'react'
import { Archive, Brain, Copy, Ellipsis, Link2, MessageSquare, Mic, Pencil, Pin, Settings2, Share2, Trash2 } from 'lucide-react'
import { Button } from '../../components/Button'
import { Card } from '../../components/Card'
import { ConfirmDialog, useConfirm } from '../../components/ConfirmDialog'
import { ContextMenu } from '../../components/ContextMenu'
import { Dialog } from '../../components/Dialog'
import { IconButton } from '../../components/IconButton'
import { Menu, type MenuItem } from '../../components/Menu'
import { Popover } from '../../components/Popover'
import { Select } from '../../components/Select'
import { Sheet } from '../../components/Sheet'
import { Switch } from '../../components/Switch'
import { Tabs } from '../../components/Tabs'
import { TextField } from '../../components/TextField'
import { toast } from '../../components/Toast'
import { ApiErrorException } from '../../lib/errors.logic'
import { apiError } from '@shared/errors'
import { Demo, Row, Section, Stack } from './Section'

export function TabsSection(): ReactNode {
  const [tab, setTab] = useState('facts')
  const [pill, setPill] = useState('week')
  const [manual, setManual] = useState('a')
  return (
    <Section id="tabs" title="Tabs" description="Roving tabindex: Tab enters at the selected tab, ← → Home End move (automatic activation).">
      <Demo label="Line, with panels" wide testId="gallery-tabs-line">
        <Tabs
          aria-label="Memory"
          value={tab}
          onChange={setTab}
          items={[
            { value: 'facts', label: 'About you', icon: <Pin />, badge: 4, content: <p className="g-note">Pinned facts Vesper always knows.</p> },
            { value: 'sessions', label: 'Sessions', icon: <MessageSquare />, content: <p className="g-note">Sessions and their links.</p> },
            { value: 'index', label: 'Memory index', icon: <Brain />, content: <p className="g-note">Voyage index status.</p> },
            { value: 'locked', label: 'Disabled', disabled: true, content: null }
          ]}
        />
      </Demo>
      <Demo label="Pill · manual activation">
        <Stack>
          <Tabs
            aria-label="Range"
            variant="pill"
            value={pill}
            onChange={setPill}
            items={[
              { value: 'day', label: 'Today' },
              { value: 'week', label: 'This week' },
              { value: 'all', label: 'All time' }
            ]}
          />
          <Tabs
            aria-label="Manual"
            activation="manual"
            value={manual}
            onChange={setManual}
            items={[
              { value: 'a', label: 'Enter selects', content: <p className="g-note">Arrows move focus; Enter or Space selects.</p> },
              { value: 'b', label: 'Second', content: <p className="g-note">Second panel.</p> }
            ]}
          />
        </Stack>
      </Demo>
    </Section>
  )
}

export function MenusSection(): ReactNode {
  const [last, setLast] = useState('—')
  const [pinned, setPinned] = useState(false)
  const [density, setDensity] = useState('cozy')
  const items: MenuItem[] = [
    { kind: 'label', label: 'Chat' },
    { id: 'rename', label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: () => setLast('Rename') },
    { id: 'copy', label: 'Copy link', icon: <Link2 />, shortcut: 'Mod+Shift+C', onSelect: () => setLast('Copy link') },
    { id: 'share', label: 'Export…', icon: <Share2 />, onSelect: () => setLast('Export') },
    { id: 'archive', label: 'Archive', icon: <Archive />, disabled: true, onSelect: () => setLast('Archive') },
    { kind: 'checkbox', id: 'pin', label: 'Pinned', checked: pinned, onCheckedChange: (v) => (setPinned(v), setLast(v ? 'Pinned' : 'Unpinned')) },
    { kind: 'separator' },
    { kind: 'label', label: 'Density' },
    { kind: 'radio', id: 'cozy', label: 'Cozy', checked: density === 'cozy', onSelect: () => (setDensity('cozy'), setLast('Cozy')) },
    { kind: 'radio', id: 'compact', label: 'Compact', checked: density === 'compact', onSelect: () => (setDensity('compact'), setLast('Compact')) },
    { kind: 'separator' },
    { id: 'delete', label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setLast('Delete') }
  ]
  return (
    <Section id="menus" title="Menu · ContextMenu · Popover" description="Menus: ↑ ↓ wrap, Home End, type to jump, Enter/Space, Esc returns focus to the button.">
      <Demo label="Menu button" testId="gallery-menu">
        <Row>
          <Menu aria-label="Chat actions" trigger={<Button iconRight={<Ellipsis />} data-testid="g-menu-trigger">Actions</Button>} items={items} />
          <Menu aria-label="More" placement="bottom-end" trigger={<IconButton label="More options" icon={<Ellipsis />} />} items={items.slice(0, 4)} />
        </Row>
        <p className="g-note">
          Last action: <strong data-testid="g-menu-result">{last}</strong>
        </p>
      </Demo>
      <Demo label="Context menu (right-click, long-press, Shift+F10)">
        <ContextMenu
          aria-label="Message actions"
          items={[
            { id: 'copy', label: 'Copy', icon: <Copy />, shortcut: 'Mod+C', onSelect: () => setLast('Copy message') },
            { id: 'speak', label: 'Speak again', icon: <Mic />, onSelect: () => setLast('Speak again') },
            { kind: 'separator' },
            { id: 'del', label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => setLast('Delete message') }
          ]}
        >
          <div className="g-context" tabIndex={0} data-testid="g-context-target">
            Right-click (or focus and press Shift+F10) for message actions.
          </div>
        </ContextMenu>
      </Demo>
      <Demo label="Popover">
        <Popover
          title="Open this link?"
          trigger={<Button>Open link…</Button>}
          width={300}
        >
          {(close) => (
            <>
              <p>
                The link goes to <strong>192.168.1.20</strong>, a device on your network.
              </p>
              <Row>
                <Button size="sm" onClick={close}>
                  Cancel
                </Button>
                <Button size="sm" variant="primary" onClick={() => (close(), setLast('Opened link'))}>
                  Open
                </Button>
              </Row>
            </>
          )}
        </Popover>
      </Demo>
    </Section>
  )
}

export function OverlaysSection(): ReactNode {
  const [open, setOpen] = useState(false)
  const [nested, setNested] = useState(false)
  const [sheet, setSheet] = useState<null | 'auto' | 'start' | 'bottom'>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [typed, setTyped] = useState(false)
  const [failing, setFailing] = useState(false)
  const [choice, setChoice] = useState<string | null>('a')
  const [sw, setSw] = useState(true)
  const { confirm, dialog } = useConfirm()
  return (
    <Section id="overlays" title="Dialog · Sheet · Confirm · Toast" description="Modal: focus moves in, Tab is trapped, Esc closes the top layer only, focus returns to the opener.">
      <Demo label="Dialog" testId="gallery-dialog">
        <Row>
          <Button onClick={() => setOpen(true)} data-testid="g-dialog-open">
            Open dialog
          </Button>
        </Row>
      </Demo>
      <Demo label="Sheet">
        <Row>
          <Button onClick={() => setSheet('auto')} data-testid="g-sheet-open">
            Sheet (auto)
          </Button>
          <Button variant="ghost" onClick={() => setSheet('start')}>
            From the start
          </Button>
          <Button variant="ghost" onClick={() => setSheet('bottom')}>
            Bottom sheet
          </Button>
        </Row>
      </Demo>
      <Demo label="ConfirmDialog">
        <Row>
          <Button variant="danger" icon={<Trash2 />} onClick={() => setConfirmOpen(true)}>
            Delete chat…
          </Button>
          <Button onClick={() => setTyped(true)}>Typed confirmation…</Button>
          <Button onClick={() => setFailing(true)}>Failing action…</Button>
          <Button
            variant="ghost"
            onClick={async () => {
              const ok = await confirm({ title: 'Forget this memory?', description: 'It is removed from search and recall.', confirmLabel: 'Forget', tone: 'danger' })
              toast.info(ok ? 'Forgotten' : 'Kept')
            }}
          >
            useConfirm()
          </Button>
        </Row>
      </Demo>
      <Demo label="Toast">
        <Row>
          <Button onClick={() => toast.info('Indexing earlier messages…')}>Info</Button>
          <Button onClick={() => toast.success('Saved')}>Success</Button>
          <Button onClick={() => toast.warning('Memory is keyword-only for now', { title: 'Heads up' })}>Warning</Button>
          <Button onClick={() => toast.error("Can't reach the AI service", { action: { label: 'Retry', onClick: () => toast.info('Retrying') } })}>Error</Button>
        </Row>
      </Demo>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Session settings"
        description="A Select and a Switch inside a dialog: the listbox opens above it and Esc closes only the listbox."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Close</Button>
            <Button variant="primary" onClick={() => setNested(true)} data-testid="g-dialog-nested">
              Open nested
            </Button>
          </>
        }
      >
        <Stack>
          <TextField label="Title" defaultValue="Trip to Kyoto" />
          <Select label="Memory scope" value={choice} onChange={setChoice} options={[{ value: 'a', label: 'Linked sessions only' }, { value: 'b', label: 'All sessions' }, { value: 'c', label: 'This session only' }]} id="g-dialog-select" />
          <Switch label="Private" description="Never sent to Voyage." checked={sw} onChange={setSw} />
        </Stack>
      </Dialog>
      <Dialog
        open={nested}
        onClose={() => setNested(false)}
        title="Nested dialog"
        size="sm"
        dismissible={false}
        description="Needs an explicit choice: Esc and the scrim do nothing."
        footer={
          <Button variant="primary" onClick={() => setNested(false)}>
            Done
          </Button>
        }
      />
      <Sheet
        open={sheet !== null}
        onClose={() => setSheet(null)}
        side={sheet ?? 'auto'}
        title="Chat panel"
        description="Bottom sheet on phones (drag the handle down), side sheet on wider screens."
        footer={
          <>
            <Button onClick={() => setSheet(null)}>Cancel</Button>
            <Button variant="primary" icon={<Settings2 />} onClick={() => setSheet(null)}>
              Apply
            </Button>
          </>
        }
      >
        <Stack>
          <TextField label="Title" defaultValue="Morning journal" />
          <Switch label="Private" checked={sw} onChange={setSw} />
          <Card title="Linked sessions" description="2 sessions can recall this one." padding="sm" />
        </Stack>
      </Sheet>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        tone="danger"
        title="Delete this chat?"
        description="It moves to the trash for 30 days; you can restore it from there."
        confirmLabel="Delete"
        onConfirm={() => void toast.success('Deleted (not really)')}
      />
      <ConfirmDialog
        open={typed}
        onClose={() => setTyped(false)}
        tone="danger"
        title="Delete all memory?"
        description="The local memory index is erased. Chats stay."
        requireText="DELETE"
        confirmLabel="Delete memory"
        onConfirm={() => new Promise<void>((r) => window.setTimeout(r, 500))}
      />
      <ConfirmDialog
        open={failing}
        onClose={() => setFailing(false)}
        title="Re-index memory?"
        description="This one fails, to show the error state."
        confirmLabel="Re-index"
        onConfirm={async () => {
          await new Promise((r) => window.setTimeout(r, 300))
          throw new ApiErrorException(apiError('network'))
        }}
      />
      {dialog}
    </Section>
  )
}
