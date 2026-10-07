/**
 * App actions shared by the Ctrl+K palette, the keyboard shortcuts and the top bar: one definition each, so a
 * shortcut, a palette entry and a button never drift apart. `registerDefaultShortcuts()` binds the standard keys.
 */
import { navigate, getLocation } from '../../lib/router'
import { useStore } from '../../lib/store'
import { toast } from '../../components/Toast'
import { copySessionId, startNewChat, startTemporaryChat } from '../sessions/data'
import { activityOf } from '../sessions/group.logic'
import { openTalkMode } from '../presence'
import { setSpeakReplies, speakRepliesNow, voiceAvailable } from '../sessions/speakReplies'
import { registerShortcut, setHelpTab } from './shortcuts'

const phoneNow = (): boolean => window.matchMedia('(max-width: 719.98px)').matches

export const actions = {
  newChat: (): void => void startNewChat(),
  newTemporaryChat: (): void => void startTemporaryChat(),
  searchMessages: (q?: string): void => navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search'),
  openSettings: (section?: string): void => navigate(section ? `/settings/${section}` : '/settings'),
  openConstellation: (): void => navigate('/constellation'),
  /** The memory viewer: timeline, chats (the manifest) and links, pinned facts, protocols (R7, R8). */
  openMemory: (): void => navigate('/memory'),
  openPrompts: (): void => navigate('/prompts'),
  openTalk: (): void => {
    const uid = useStore.getState().activeSessionUid
    if (uid) openTalkMode(uid)
    else toast.info('Open a chat first, then start Talk mode.')
  },
  /** Pause or resume the Star's animation on this device (presence; also /star pause|resume). */
  toggleStarPaused: (): void => {
    const st = useStore.getState()
    const paused = !st.presence.paused
    st.setStarPaused(paused)
    toast.info(paused ? 'The Star is paused on this device.' : 'The Star moves again.', { id: 'star-paused', durationMs: 2500 })
  },
  toggleSidebar: (): void => {
    const st = useStore.getState()
    if (phoneNow()) st.setSidebarOpen(!st.ui.sidebarOpen)
    else st.setSidebarCollapsed(!st.ui.sidebarCollapsed)
  },
  togglePanel: (): void => {
    const st = useStore.getState()
    if (!st.activeSessionUid) return
    st.setPanelOpen(!st.ui.panelOpen)
  },
  toggleVoice: (): void => {
    if (!voiceAvailable(useStore.getState().settings)) {
      toast.info('Voice replies need a voice provider.', { action: { label: 'Set up voice', onClick: () => navigate('/settings/voice-out') } })
      return
    }
    const on = !speakRepliesNow()
    setSpeakReplies(on)
    toast.info(on ? 'Replies will be spoken on this device.' : 'Replies will be text only on this device.', { id: 'voice-toggle', durationMs: 2500 })
  },
  copySessionId: (): void => {
    const st = useStore.getState()
    const s = st.activeSession ?? st.sessions.items.find((x) => x.uid === st.activeSessionUid)
    if (s) void copySessionId(s.shortId)
  },
  showShortcuts: (): void => useStore.getState().setShortcutsOpen(true),
  /** The help sheet on a tab: 'commands' is what /help shows. */
  openHelp: (tab: 'keys' | 'commands' = 'keys'): void => {
    setHelpTab(tab)
    useStore.getState().setShortcutsOpen(true)
  },
  openPalette: (seed = ''): void => {
    const st = useStore.getState()
    if (st.ui.paletteOpen) st.closePalette()
    else st.openPalette(seed)
  },
  /** Next/previous chat in the sidebar's order (most recent activity first, pinned on top). */
  stepChat: (dir: 1 | -1): void => {
    const st = useStore.getState()
    const items = [...st.sessions.items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || activityOf(b) - activityOf(a))
    if (!items.length) return
    const at = items.findIndex((s) => s.uid === st.activeSessionUid)
    const next = items[at < 0 ? 0 : Math.min(items.length - 1, Math.max(0, at + dir))]
    if (next && next.uid !== st.activeSessionUid) navigate(`/s/${next.uid}`)
  }
}

const inChat = (): boolean => getLocation().pathname.startsWith('/s/')

let registered = false

export function registerDefaultShortcuts(): void {
  if (registered) return
  registered = true
  // "app." ids keep working while a dialog is open (they toggle the palette / help themselves).
  registerShortcut({ id: 'app.palette', keys: 'Mod+K', label: 'Command palette', group: 'General', run: () => actions.openPalette() })
  registerShortcut({ id: 'app.help', keys: 'Mod+/', alt: ['?'], label: 'Keyboard shortcuts', group: 'General', run: () => {
    const st = useStore.getState()
    st.setShortcutsOpen(!st.ui.shortcutsOpen)
  } })
  registerShortcut({ id: 'nav.search', keys: 'Mod+Shift+F', label: 'Search all messages', group: 'General', run: () => actions.searchMessages() })
  registerShortcut({ id: 'nav.settings', keys: 'Mod+,', label: 'Settings', group: 'General', run: () => actions.openSettings() })
  registerShortcut({ id: 'nav.sidebar', keys: 'Mod+Shift+S', label: 'Show or hide the chat list', group: 'General', run: actions.toggleSidebar })
  registerShortcut({ id: 'chats.new', keys: 'Mod+Shift+O', label: 'New chat', group: 'Chats', run: actions.newChat })
  registerShortcut({ id: 'chats.next', keys: 'Alt+Shift+ArrowDown', label: 'Next chat', group: 'Chats', run: () => actions.stepChat(1) })
  registerShortcut({ id: 'chats.prev', keys: 'Alt+Shift+ArrowUp', label: 'Previous chat', group: 'Chats', run: () => actions.stepChat(-1) })
  registerShortcut({ id: 'chats.panel', keys: 'Mod+.', label: 'Show or hide the chat panel', group: 'Chats', run: actions.togglePanel, when: inChat })
  // Display-only: handled where they live (chat-ui's page and composer, 07 D1/D9), listed here so "?" shows them.
  registerShortcut({ id: 'chat.send', keys: 'Enter', label: 'Send (Shift+Enter for a new line)', group: 'In a chat' })
  registerShortcut({ id: 'chat.find', keys: 'Mod+F', label: 'Search in this chat', group: 'In a chat' })
  registerShortcut({ id: 'chat.messages', keys: 'Alt+ArrowUp', alt: ['Alt+ArrowDown'], label: 'Previous / next message', group: 'In a chat' })
  registerShortcut({ id: 'chat.slash', keys: '/', label: 'Commands (type / in the message box)', group: 'In a chat' })
  registerShortcut({ id: 'list.move', keys: 'ArrowUp', alt: ['ArrowDown'], label: 'Move between chats', group: 'Chat list' })
  registerShortcut({ id: 'list.rename', keys: 'F2', label: 'Rename the chat', group: 'Chat list' })
  registerShortcut({ id: 'list.delete', keys: 'Delete', label: 'Move the chat to Trash', group: 'Chat list' })
  registerShortcut({ id: 'list.menu', keys: 'Shift+F10', label: 'Chat menu', group: 'Chat list' })
}
