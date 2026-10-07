/**
 * Ctrl+K command palette (research 07 §4.2): one box for chats (titles, #IDs), app actions (new chat, temporary chat,
 * voice, Talk mode, Constellation, memory viewer, prompt library, search, shortcuts), Settings sections and — after "/" — slash commands with
 * argument completion. APG combobox + listbox: ↑/↓ move, Enter runs, Tab completes a command, Esc closes.
 * A transient surface (glass allowed, 07 D10); modal through the kit's layer stack.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowRight,
  BookText,
  Brain,
  CornerDownLeft,
  Ghost,
  Keyboard,
  MessageSquare,
  MessageSquarePlus,
  Orbit,
  PanelLeft,
  PanelRight,
  Search,
  Slash,
  TextSearch,
  Volume2,
  AudioLines,
  ChevronRight,
  Pause,
  Play
} from 'lucide-react'
import { formatShortId } from '@shared/ids'
import { Kbd } from '../../components/Kbd'
import { pushLayer } from '../../components/internal/layers'
import { runCommand } from '../../lib/commands/registry'
import { navigate } from '../../lib/router'
import { useStore } from '../../lib/store'
import { toast } from '../../components/Toast'
import { settingsSections } from '../settings/sections'
import { activityOf, titleOf } from '../sessions/group.logic'
import { actions } from './actions'
import { completeCommandLine, type CommandCompletion } from './completion'
import { paletteContext } from './context'
import { matchRanges, rank, splitRuns } from './palette.logic'
import { shortcutKeys } from './shortcuts'
import './palette.css'

interface Item {
  id: string
  group: 'Chats' | 'Actions' | 'Settings' | 'Commands' | 'Search'
  label: string
  /** Dimmed text right after the label (a command's argument usage). */
  usage?: string
  description?: string
  icon: ReactNode
  keys?: string
  /** Highlight query matches in the label. */
  highlight?: boolean
  run: () => void
  /** Commands: Tab/Enter on a non-final item fills the box instead of running. */
  completion?: CommandCompletion
}

const GROUP_ORDER: Item['group'][] = ['Commands', 'Actions', 'Chats', 'Settings', 'Search']

export default function Palette(): ReactNode {
  const seed = useStore((s) => s.ui.paletteSeed)
  const close = useStore((s) => s.closePalette)
  const sessions = useStore((s) => s.sessions.items)
  const activeUid = useStore((s) => s.activeSessionUid)
  const [query, setQuery] = useState(seed)
  const [active, setActive] = useState(0)
  const [completions, setCompletions] = useState<CommandCompletion[]>([])
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const commandMode = query.trimStart().startsWith('/')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const pop = pushLayer({ el, modal: true, onEscape: () => useStore.getState().closePalette() })
    input.current?.focus()
    const len = input.current?.value.length ?? 0
    input.current?.setSelectionRange(len, len)
    return pop
  }, [])

  // Command completions are async (prompt names, models, sessions from the server): newest query wins.
  useEffect(() => {
    if (!commandMode) {
      setCompletions([])
      return
    }
    const ctrl = new AbortController()
    void completeCommandLine(query, paletteContext(), ctrl.signal).then((c) => {
      if (!ctrl.signal.aborted) setCompletions(c)
    })
    return () => ctrl.abort()
  }, [query, commandMode])

  const finish = (fn: () => void): void => {
    close()
    fn()
  }

  const items = useMemo((): Item[] => {
    const q = query.trim()
    if (commandMode) {
      const typed = q
      const list: Item[] = completions.map((c) => ({
        id: `c:${c.text}`,
        group: 'Commands',
        label: c.label,
        usage: c.usage,
        description: c.description,
        icon: c.kind === 'argument' ? <ChevronRight /> : <Slash />,
        completion: c,
        run: () => void finish(() => void runCommand(c.text.trim(), paletteContext()))
      }))
      // The line as typed, when it is a complete command the list doesn't already offer.
      if (typed.length > 1 && /\s/.test(typed) && !list.some((i) => i.completion?.text.trim() === typed)) {
        list.unshift({ id: 'c:typed', group: 'Commands', label: `Run ${typed}`, icon: <CornerDownLeft />, run: () => finish(() => void runCommandOrSay(typed)) })
      }
      return list
    }

    const st = useStore.getState()
    const inChat = !!st.activeSessionUid
    const voiceOn = st.settings?.voice.tts.enabled ?? false
    const starPaused = st.presence.paused
    const act: Item[] = [
      { id: 'a:new', group: 'Actions', label: 'New chat', icon: <MessageSquarePlus />, keys: shortcutKeys('chats.new'), run: () => finish(actions.newChat) },
      { id: 'a:temp', group: 'Actions', label: 'New temporary chat', description: 'Not saved or remembered', icon: <Ghost />, run: () => finish(actions.newTemporaryChat) },
      { id: 'a:search', group: 'Actions', label: 'Search all messages', icon: <TextSearch />, keys: shortcutKeys('nav.search'), run: () => finish(() => actions.searchMessages()) },
      ...(inChat ? [{ id: 'a:talk', group: 'Actions' as const, label: 'Talk mode', description: 'A voice conversation with the Star in this chat', icon: <AudioLines />, run: () => finish(actions.openTalk) }] : []),
      { id: 'a:voice', group: 'Actions', label: voiceOn ? 'Turn voice replies on or off' : 'Set up voice replies', icon: <Volume2 />, run: () => finish(actions.toggleVoice) },
      { id: 'a:memory', group: 'Actions', label: 'Memory viewer', description: 'Timeline, chats and links, what the AI remembers', icon: <Brain />, run: () => finish(actions.openMemory) },
      { id: 'a:prompts', group: 'Actions', label: 'Prompt library', description: 'Saved system prompts', icon: <BookText />, run: () => finish(actions.openPrompts) },
      { id: 'a:const', group: 'Actions', label: 'Open the Constellation', description: 'Your chats as a map of stars', icon: <Orbit />, run: () => finish(actions.openConstellation) },
      {
        id: 'a:star',
        group: 'Actions',
        label: starPaused ? 'Resume the Star' : 'Pause the Star',
        description: starPaused ? 'Let it move again on this device' : 'Stop its animation on this device',
        icon: starPaused ? <Play /> : <Pause />,
        run: () => finish(actions.toggleStarPaused)
      },
      ...(inChat ? [{ id: 'a:panel', group: 'Actions' as const, label: 'Show or hide the chat panel', icon: <PanelRight />, keys: shortcutKeys('chats.panel'), run: () => finish(actions.togglePanel) }] : []),
      { id: 'a:sidebar', group: 'Actions', label: 'Show or hide the chat list', icon: <PanelLeft />, keys: shortcutKeys('nav.sidebar'), run: () => finish(actions.toggleSidebar) },
      { id: 'a:keys', group: 'Actions', label: 'Keyboard shortcuts', icon: <Keyboard />, keys: shortcutKeys('app.help'), run: () => finish(actions.showShortcuts) },
      { id: 'a:commands', group: 'Actions', label: 'Slash commands', description: 'Type / to see them', icon: <Slash />, run: () => setQuery('/') }
    ]
    const chats: Item[] = [...sessions]
      .sort((a, b) => activityOf(b) - activityOf(a))
      .filter((s) => s.uid !== activeUid || q)
      .map((s) => ({
        id: `s:${s.uid}`,
        group: 'Chats' as const,
        label: titleOf(s),
        description: formatShortId(s.shortId),
        icon: s.temporary ? <Ghost /> : <MessageSquare />,
        highlight: true,
        run: () => finish(() => navigate(`/s/${s.uid}`))
      }))
    const settings: Item[] = settingsSections.map((sec) => {
      const Icon = sec.icon
      return { id: `p:${sec.id}`, group: 'Settings' as const, label: sec.title, description: 'Settings', icon: <Icon />, highlight: true, run: () => finish(() => actions.openSettings(sec.id)) }
    })

    if (!q) return [...act.slice(0, 6), ...chats.slice(0, 6)]
    const texts = (i: Item): string[] => [i.label, i.description ?? '', i.id.startsWith('s:') ? i.id.slice(2) : '']
    return [
      ...rank(q, act, texts, 5),
      ...rank(q, chats, texts, 8),
      ...rank(q, settings, texts, 4),
      { id: 'q:search', group: 'Search', label: `Search messages for “${q}”`, icon: <Search />, run: () => finish(() => actions.searchMessages(q)) }
    ]
  }, [query, commandMode, completions, sessions, activeUid])

  // Keep the active row valid and visible.
  useEffect(() => setActive(0), [query])
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (i: number, viaTab = false): void => {
    const it = items[i]
    if (!it) return
    if (it.completion && (viaTab || !it.completion.final)) {
      setQuery(it.completion.text)
      input.current?.focus()
      return
    }
    it.run()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % items.length : (a - 1 + items.length) % items.length))
    } else if (e.key === 'Home' && e.ctrlKey) {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End' && e.ctrlKey) {
      e.preventDefault()
      setActive(Math.max(0, items.length - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (items.length) choose(active)
      else if (commandMode && query.trim().length > 1) finish(() => void runCommandOrSay(query.trim()))
    } else if (e.key === 'Tab' && commandMode && items[active]?.completion) {
      e.preventDefault()
      choose(active, true)
    }
  }

  const groups = GROUP_ORDER.map((g) => ({ g, list: items.map((it, index) => ({ it, index })).filter((x) => x.it.group === g) })).filter((x) => x.list.length)
  const activeId = items[active] ? `${listId}-o${active}` : undefined
  const q = query.trim()

  return createPortal(
    <div className="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className="palette glass" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette__search">
          {commandMode ? <Slash aria-hidden="true" /> : <Search aria-hidden="true" />}
          <input
            ref={input}
            className="palette__input"
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search chats, actions and settings, or type / for commands"
            placeholder="Search, or type / for commands"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette__list" ref={listRef} role="listbox" id={listId} aria-label="Results">
          {groups.map(({ g, list }) => (
            <div key={g} role="group" aria-labelledby={`${listId}-${g}`} className="palette__group">
              <div className="palette__group-title" id={`${listId}-${g}`} role="presentation">
                {g === 'Search' ? 'Everything else' : g}
              </div>
              {list.map(({ it, index }) => (
                <div
                  key={it.id}
                  id={`${listId}-o${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  className={`palette__item${index === active ? ' is-active' : ''}`}
                  onPointerMove={() => setActive(index)}
                  onClick={() => choose(index)}
                >
                  <span className="palette__icon" aria-hidden="true">
                    {it.icon}
                  </span>
                  <span className="palette__text">
                    <span className={`palette__label${it.usage ? ' palette__label--usage' : ''}`}>
                      {it.highlight && q && !commandMode ? <Highlighted text={it.label} query={q} /> : it.label}
                      {it.usage ? <span className="palette__usage"> {it.usage}</span> : null}
                    </span>
                    {it.description ? <span className="palette__desc">{it.description}</span> : null}
                  </span>
                  {it.keys ? <Kbd keys={it.keys} className="palette__keys" /> : index === active ? <ArrowRight className="palette__go" aria-hidden="true" /> : null}
                </div>
              ))}
            </div>
          ))}
          {!items.length ? (
            <p className="palette__empty" role="status">
              {commandMode ? (query.trim() === '/' ? 'No commands available here.' : 'No matching command. Enter sends it anyway if it is one.') : 'Nothing found.'}
            </p>
          ) : null}
        </div>
        <div className="palette__foot" aria-hidden="true">
          <span>
            <Kbd keys="Up" /> <Kbd keys="Down" /> move
          </span>
          <span>
            <Kbd keys="Enter" /> open
          </span>
          {commandMode ? (
            <span>
              <Kbd keys="Tab" /> complete
            </span>
          ) : (
            <span>
              <Kbd>/</Kbd> commands
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  return splitRuns(text, matchRanges(query, text)).map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : <span key={i}>{r.text}</span>))
}

async function runCommandOrSay(text: string): Promise<void> {
  const ok = await runCommand(text, paletteContext())
  if (!ok) toast.info(`“${text.split(/\s/)[0]}” isn't a command here. /help lists them.`)
}
