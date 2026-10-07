/**
 * WindowController — loading for one open session's MessageWindow (research 03 §4.4 steps 1–8, 07 D1):
 *   open/reload/jump replace the window (`latest` or `around`), older/newer pages extend it, at most one request in
 *   flight per direction, and every replace bumps a token so late responses are ignored (step 7).
 * The list component positions itself from `target` after each replace and trims the far end after each extension.
 */
import type { ApiError } from '@shared/errors'
import type { MessagePage } from '@shared/types/domain'
import { api } from '../../../lib/api'
import { toApiError } from '../../../lib/errors.logic'
import { useStore } from '../../../lib/store'
import { inWindow } from '../../../lib/store/chat.logic'

export type WindowTarget =
  | { kind: 'bottom' }
  /** Restore a saved place: the row at `seq` with its top `offset` px from the viewport top (VirtualList anchor). */
  | { kind: 'anchor'; seq: number; offset: number }
  /** Bring `seq` into view (search hit, memory citation, permalink) and flash it. */
  | { kind: 'seq'; seq: number; flash: boolean; align?: 'start' | 'center'; focus?: boolean }

export interface ViewAnchor {
  seq: number
  offset: number
  pinned: boolean
}

export interface LoadState {
  up: boolean
  down: boolean
  replace: boolean
  upError: ApiError | null
  downError: ApiError | null
}

export class WindowController {
  readonly uid: string
  pageSize: number
  /** Where the list should go after the next replace commits. */
  target: WindowTarget | null = null
  /** MessageWindow: position a seq that is already loaded. Returns false when it isn't. */
  positioner: ((t: WindowTarget) => boolean) | null = null
  /** MessageWindow: the reader's current place (for reloads and saved view state). */
  viewAnchor: (() => ViewAnchor | null) | null = null
  /** MessageWindow: called after an older/newer page committed (trim the far end). */
  onExtended: ((side: 'top' | 'bottom') => void) | null = null

  private token = 0
  private replaceCtrl: AbortController | null = null
  private upCtrl: AbortController | null = null
  private downCtrl: AbortController | null = null
  private state: LoadState = { up: false, down: false, replace: false, upError: null, downError: null }
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(uid: string, pageSize: number) {
    this.uid = uid
    this.pageSize = pageSize
  }

  // ── subscription (useSyncExternalStore) ─────────────────────────────────────────────────────
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => void this.listeners.delete(cb)
  }
  getState = (): LoadState => this.state
  private set(patch: Partial<LoadState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of [...this.listeners]) l()
  }

  private view() {
    return useStore.getState().chats[this.uid]
  }

  // ── replacing loads ─────────────────────────────────────────────────────────────────────────
  private replace(mode: 'latest' | 'around', seq: number | undefined, target: WindowTarget): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const token = ++this.token
    this.replaceCtrl?.abort()
    this.upCtrl?.abort()
    this.downCtrl?.abort()
    this.upCtrl = this.downCtrl = null
    const ctrl = new AbortController()
    this.replaceCtrl = ctrl
    this.set({ replace: true, up: false, down: false, upError: null, downError: null })
    useStore.getState().chatReload(this.uid)
    return api('GET /api/sessions/:uid/messages', {
      params: { uid: this.uid },
      query: mode === 'latest' ? { mode, limit: this.pageSize } : { mode, seq, limit: this.pageSize },
      signal: ctrl.signal
    })
      .then((page) => {
        if (token !== this.token || this.disposed) return
        this.target = target
        useStore.getState().chatLoaded(this.uid, page)
      })
      .catch((e: unknown) => {
        if (token !== this.token || this.disposed || ctrl.signal.aborted) return
        useStore.getState().chatFailed(this.uid, toApiError(e))
      })
      .finally(() => {
        if (token === this.token && !this.disposed) {
          this.replaceCtrl = null
          this.set({ replace: false })
        }
      })
  }

  /** Step 1: pinned (or nothing saved) → latest; otherwise around the saved anchor. */
  open(saved: { anchorSeq: number; offsetPx: number; pinned: boolean } | null): Promise<void> {
    if (!saved || saved.pinned) return this.replace('latest', undefined, { kind: 'bottom' })
    return this.replace('around', saved.anchorSeq, { kind: 'anchor', seq: saved.anchorSeq, offset: saved.offsetPx })
  }

  /** Resync / path change / retry: keep the reader's place. */
  reload(): Promise<void> {
    const a = this.viewAnchor?.() ?? null
    if (!a || a.pinned) return this.replace('latest', undefined, { kind: 'bottom' })
    return this.replace('around', a.seq, { kind: 'anchor', seq: a.seq, offset: a.offset })
  }

  /** Step 6: jump to a seq (replace the window around it unless it is loaded). */
  jumpToSeq(seq: number, flash = true, align: 'start' | 'center' = 'center', focus = flash): Promise<void> {
    const t: WindowTarget = { kind: 'seq', seq, flash, align, focus }
    const v = this.view()
    if (v && v.status === 'ready' && inWindow(v, seq) && this.positioner?.(t)) return Promise.resolve()
    return this.replace('around', seq, t)
  }

  /** Jump to a message by uid: select its branch first when it is an earlier version (07 C3). */
  async jumpToMessage(messageUid: string, focus = true): Promise<boolean> {
    const loc = await api('GET /api/messages/:uid/locate', { params: { uid: messageUid } })
    if (loc.sessionUid !== this.uid) return false
    if (!loc.onPath) {
      for (const step of loc.branchPath) {
        await api('POST /api/sessions/:uid/variants/:seq', { params: { uid: this.uid, seq: step.forkSeq }, body: { branchId: step.branchId } })
      }
    }
    await this.jumpToSeq(loc.seq, true, 'center', focus)
    return true
  }

  /** "Jump to latest": scroll when the window is at the live edge, else load `latest`. */
  jumpLatest(): Promise<void> {
    const v = this.view()
    if (v && v.status === 'ready' && !v.hasAfter && this.positioner?.({ kind: 'bottom' })) return Promise.resolve()
    return this.replace('latest', undefined, { kind: 'bottom' })
  }

  // ── extending loads (steps 2–3) ─────────────────────────────────────────────────────────────
  loadOlder(): void {
    const v = this.view()
    if (this.disposed || this.state.up || this.state.replace || !v || v.status !== 'ready' || !v.hasBefore || v.messages.length === 0) return
    const token = this.token
    const ctrl = new AbortController()
    this.upCtrl = ctrl
    this.set({ up: true, upError: null })
    api('GET /api/sessions/:uid/messages', { params: { uid: this.uid }, query: { mode: 'before', seq: v.loSeq, limit: this.pageSize }, signal: ctrl.signal })
      .then((page: MessagePage) => {
        if (token !== this.token || this.disposed) return
        useStore.getState().chatPrepended(this.uid, page)
        this.onExtended?.('top')
      })
      .catch((e: unknown) => {
        if (token === this.token && !this.disposed && !ctrl.signal.aborted) this.set({ upError: toApiError(e) })
      })
      .finally(() => {
        if (this.upCtrl === ctrl) {
          this.upCtrl = null
          if (!this.disposed) this.set({ up: false })
        }
      })
  }

  loadNewer(): void {
    const v = this.view()
    if (this.disposed || this.state.down || this.state.replace || !v || v.status !== 'ready' || !v.hasAfter || v.messages.length === 0) return
    const token = this.token
    const ctrl = new AbortController()
    this.downCtrl = ctrl
    this.set({ down: true, downError: null })
    api('GET /api/sessions/:uid/messages', { params: { uid: this.uid }, query: { mode: 'after', seq: v.hiSeq, limit: this.pageSize }, signal: ctrl.signal })
      .then((page: MessagePage) => {
        if (token !== this.token || this.disposed) return
        useStore.getState().chatAppended(this.uid, page)
        this.onExtended?.('bottom')
      })
      .catch((e: unknown) => {
        if (token === this.token && !this.disposed && !ctrl.signal.aborted) this.set({ downError: toApiError(e) })
      })
      .finally(() => {
        if (this.downCtrl === ctrl) {
          this.downCtrl = null
          if (!this.disposed) this.set({ down: false })
        }
      })
  }

  /** (Re)activate after a dispose — React StrictMode runs effects twice in development. */
  activate(): void {
    this.disposed = false
  }

  dispose(): void {
    this.disposed = true
    this.token++
    this.replaceCtrl?.abort()
    this.upCtrl?.abort()
    this.downCtrl?.abort()
    this.replaceCtrl = this.upCtrl = this.downCtrl = null
    this.listeners.clear()
    this.positioner = this.viewAnchor = this.onExtended = null
  }
}
