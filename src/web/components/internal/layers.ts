/**
 * One stack for every overlay the kit opens (dialogs, sheets, popovers, menus, listboxes), so they nest correctly:
 *
 * - Esc goes to the top layer only (a listbox open inside a dialog closes the listbox, not the dialog).
 * - Modal layers trap Tab, keep focus inside themselves (or in a layer above them), and make the app root `inert`.
 * - A pointer down outside a non-modal layer (and outside every layer above it) tells it to close; a modal stops the
 *   search, so clicking inside a dialog closes a menu above it but never the dialog.
 * - Popping a layer returns focus to what was focused when it opened, unless the user already moved focus elsewhere.
 *
 * Document listeners exist only while at least one layer is open (counted for leak tests).
 */
import { track } from './stats'

export interface LayerOptions {
  el: HTMLElement
  modal: boolean
  /** Esc while this is the top layer. Omit on a modal to swallow Esc (dialogs that need an explicit choice). */
  onEscape?: () => void
  /** Pointer down outside this layer and every layer above it (non-modal layers only). */
  onOutsidePointer?: (e: PointerEvent) => void
  /** Elements that count as part of the layer for outside clicks (e.g. the trigger that toggles it). */
  inside?: () => ReadonlyArray<Element | null | undefined>
  /** Where focus goes when the layer closes: default the element focused at open, false = leave focus alone. */
  restoreFocus?: boolean | HTMLElement | null
}

interface Entry extends LayerOptions {
  opener: HTMLElement | null
}

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/** Tabbable elements inside `root`, in DOM order (hidden and inert ones excluded). */
export function focusables(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert]') && el.getClientRects().length > 0)
}

const stack: Entry[] = []
let modalCount = 0
let rootWasInert = false

function contains(e: Entry, target: EventTarget | null): boolean {
  if (!(target instanceof Node)) return false
  if (e.el.contains(target)) return true
  return e.inside?.().some((x) => !!x && x.contains(target)) ?? false
}

function topModalIndex(): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].modal) return i
  return -1
}

function onKeyDown(e: KeyboardEvent): void {
  const top = stack[stack.length - 1]
  if (!top || e.isComposing) return
  if (e.key === 'Escape') {
    if (top.onEscape) {
      e.preventDefault()
      e.stopPropagation()
      top.onEscape()
    } else if (top.modal) {
      e.stopPropagation()
    }
    return
  }
  if (e.key !== 'Tab' || !top.modal) return
  const list = focusables(top.el)
  if (list.length === 0) {
    e.preventDefault()
    top.el.focus({ preventScroll: true })
    return
  }
  const first = list[0]
  const last = list[list.length - 1]
  const active = document.activeElement
  const inside = active instanceof Node && top.el.contains(active)
  if (e.shiftKey && (active === first || active === top.el || !inside)) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault()
    first.focus()
  }
}

/** Focus that escapes a modal (programmatic focus, a click on the page behind) is pulled back in. */
function onFocusIn(e: FocusEvent): void {
  const m = topModalIndex()
  if (m < 0 || !(e.target instanceof Node)) return
  for (let i = m; i < stack.length; i++) if (contains(stack[i], e.target)) return
  if (e.target instanceof Element && e.target.closest('.toast-region')) return
  const modal = stack[m].el
  ;(focusables(modal)[0] ?? modal).focus({ preventScroll: true })
}

function onPointerDown(e: PointerEvent): void {
  const layers = [...stack]
  for (let i = layers.length - 1; i >= 0; i--) {
    const entry = layers[i]
    if (contains(entry, e.target) || entry.modal) return
    entry.onOutsidePointer?.(e)
  }
}

function install(): void {
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('focusin', onFocusIn)
  document.addEventListener('pointerdown', onPointerDown, true)
  track('kit.docListeners', 1)
}

function uninstall(): void {
  document.removeEventListener('keydown', onKeyDown, true)
  document.removeEventListener('focusin', onFocusIn)
  document.removeEventListener('pointerdown', onPointerDown, true)
  track('kit.docListeners', -1)
}

/** Open a layer; the returned function closes it (idempotent). */
export function pushLayer(o: LayerOptions): () => void {
  const entry: Entry = { ...o, opener: document.activeElement instanceof HTMLElement ? document.activeElement : null }
  stack.push(entry)
  track('kit.layers', 1)
  if (stack.length === 1) install()
  const root = document.getElementById('root')
  if (o.modal && modalCount++ === 0 && root) {
    rootWasInert = root.inert
    root.inert = true
  }
  let popped = false
  return () => {
    if (popped) return
    popped = true
    const i = stack.indexOf(entry)
    if (i >= 0) stack.splice(i, 1)
    track('kit.layers', -1)
    if (o.modal && --modalCount === 0 && root) root.inert = rootWasInert
    if (stack.length === 0) uninstall()
    const target = o.restoreFocus === false ? null : o.restoreFocus instanceof HTMLElement ? o.restoreFocus : entry.opener
    if (!target || !target.isConnected) return
    // Only when focus is still in the closing layer or was dropped to <body> by its removal.
    const active = document.activeElement
    if (!active || active === document.body || o.el.contains(active) || !active.isConnected) target.focus({ preventScroll: true })
  }
}

/** The top-most open layer's element, or null when none is open. */
export function topLayerElement(): HTMLElement | null {
  return stack[stack.length - 1]?.el ?? null
}

/** Is `el` the top-most open layer? */
export function isTopLayer(el: HTMLElement): boolean {
  return stack[stack.length - 1]?.el === el
}

export function openLayerCount(): number {
  return stack.length
}
