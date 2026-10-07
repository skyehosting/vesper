/**
 * Top bar slots. The shell owns the bar (title-bar drag region, sidebar/panel toggles, and on chat routes the whole
 * session header). Pages add to it with portals:
 *   <TopBarContent>  — the middle (title, page chips) on pages that are not a chat (settings, search, …); on /s/:uid
 *                      the shell's SessionHeader is the content, so this renders nothing there;
 *   <TopBarActions>  — extra buttons on the right, on any page (before the shell's voice/search/panel buttons).
 * Interactive elements put here need the `no-drag` class (the bar is the window's drag region on the desktop).
 */
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const TopBarSlotContext = createContext<HTMLElement | null>(null)
export const TopBarActionsContext = createContext<HTMLElement | null>(null)

export function TopBarContent({ children }: { children: ReactNode }): ReactNode {
  const slot = useContext(TopBarSlotContext)
  return slot ? createPortal(children, slot) : null
}

export function TopBarActions({ children }: { children: ReactNode }): ReactNode {
  const slot = useContext(TopBarActionsContext)
  return slot ? createPortal(children, slot) : null
}
