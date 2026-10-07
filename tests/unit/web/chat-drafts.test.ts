import { beforeEach, describe, expect, it } from 'vitest'

class MemoryStorage {
  private m = new Map<string, string>()
  get length(): number {
    return this.m.size
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v))
  }
  removeItem(k: string): void {
    this.m.delete(k)
  }
  clear(): void {
    this.m.clear()
  }
}
const storage = new MemoryStorage()
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = storage

const { clearDraft, loadDraft, saveDraft, storedDraftUids, sweepDrafts } = await import('../../../src/web/features/chat/composer/draft.logic')

describe('composer drafts (07 B9, F09/F17) @R9', () => {
  beforeEach(() => {
    storage.clear()
    // Each test starts like a freshly opened composer (clearDraft, then loadDraft lifts the cleared mark).
    for (const uid of ['t1', 'n1', 'u1', 'gone', 'live']) {
      clearDraft(uid)
      loadDraft(uid)
    }
  })

  it('keeps a temporary chat draft in memory only, never in localStorage', () => {
    saveDraft('t1', 'secret words', true)
    expect(storage.length).toBe(0)
    expect(loadDraft('t1', true)).toBe('secret words')
    saveDraft('t1', '', true)
    expect(loadDraft('t1', true)).toBe('')
  })

  it('removes a stored draft an older version left for a temporary chat', () => {
    storage.setItem('vesper.draft.t1', 'left behind')
    expect(loadDraft('t1', true)).toBe('')
    saveDraft('t1', 'new', true)
    expect(storage.getItem('vesper.draft.t1')).toBeNull()
  })

  it('stores an ordinary chat draft; while the kind is unknown it stays in memory, then moves to storage', () => {
    saveDraft('n1', 'hello', false)
    expect(storage.getItem('vesper.draft.n1')).toBe('hello')
    saveDraft('u1', 'not sure yet', null)
    expect(storage.getItem('vesper.draft.u1')).toBeNull()
    expect(loadDraft('u1', null)).toBe('not sure yet')
    saveDraft('u1', 'not sure yet', false)
    expect(storage.getItem('vesper.draft.u1')).toBe('not sure yet')
  })

  it('clears a draft everywhere, and sweeps stored drafts of chats that are gone or temporary', async () => {
    saveDraft('n1', 'about to be deleted', false)
    saveDraft('t1', 'temporary', true)
    clearDraft('n1')
    clearDraft('t1')
    expect(storage.getItem('vesper.draft.n1')).toBeNull()
    expect(loadDraft('t1', true)).toBe('')

    storage.setItem('vesper.draft.gone', 'x')
    storage.setItem('vesper.draft.live', 'y')
    storage.setItem('vesper.draft.t1', 'z')
    // The chat list: 'live' is ordinary, 't1' a live temporary chat, 'gone' is missing.
    const list = new Map([
      ['live', false],
      ['t1', true]
    ])
    expect(await sweepDrafts(async () => list)).toBe(2)
    expect(storedDraftUids()).toEqual(['live'])
    // When the list can't be read, nothing is removed.
    storage.setItem('vesper.draft.gone', 'x')
    expect(await sweepDrafts(async () => null)).toBe(0)
    expect(storedDraftUids().sort()).toEqual(['gone', 'live'])
  })
})

describe('a cleared draft stays cleared (F09 second pass) @R9', () => {
  beforeEach(() => {
    storage.clear()
  })

  it('ignores the unmount save of a chat deleted or ended while it is open, until a composer opens it again', () => {
    loadDraft('open1')
    saveDraft('open1', 'PRIVATE DRAFT TEXT', false)
    expect(storage.getItem('vesper.draft.open1')).toBe('PRIVATE DRAFT TEXT')
    // session.deleted runs first (clearDraft), then the open Composer unmounts and saves what it still holds.
    clearDraft('open1')
    saveDraft('open1', 'PRIVATE DRAFT TEXT', false)
    saveDraft('open1', 'PRIVATE DRAFT TEXT', null)
    expect(storage.getItem('vesper.draft.open1')).toBeNull()
    expect(loadDraft('open1', null)).toBe('')
    // Restored from Trash and opened again: a new composer (loadDraft) saves normally.
    saveDraft('open1', 'typed after restore', false)
    expect(storage.getItem('vesper.draft.open1')).toBe('typed after restore')
    // Other chats are not affected by a cleared one.
    clearDraft('open1')
    saveDraft('other', 'fine', false)
    expect(storage.getItem('vesper.draft.other')).toBe('fine')
    clearDraft('other')
  })

  it('clearAllDrafts (sign-out, revoked or expired device) removes every draft and ignores saves until a composer opens again', async () => {
    const { clearAllDrafts } = await import('../../../src/web/features/chat/composer/draft.logic')
    storage.setItem('vesper.draft.a', 'one')
    storage.setItem('vesper.draft.b', 'two')
    storage.setItem('vesper.theme', 'kept')
    loadDraft('tmp', true)
    saveDraft('tmp', 'memory only', true)
    loadDraft('c')
    clearAllDrafts()
    expect(storedDraftUids()).toEqual([])
    expect(storage.getItem('vesper.theme')).toBe('kept')
    // The composers still on screen unmount after sign-out and save what they hold: ignored.
    saveDraft('c', 'unsent text', false)
    saveDraft('tmp', 'unsent temp', true)
    expect(storedDraftUids()).toEqual([])
    expect(loadDraft('tmp', true)).toBe('')
    // After signing in again, a composer opens (loadDraft) and drafts work as before.
    expect(loadDraft('c')).toBe('')
    saveDraft('c', 'new text', false)
    expect(storage.getItem('vesper.draft.c')).toBe('new text')
    clearDraft('c')
  })
})
