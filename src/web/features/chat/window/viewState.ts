/**
 * Per-device view state (07 D1): IndexedDB `vesper-chat` / `viewState[sessionUid] = {anchorSeq, offsetPx, pinned}`,
 * saved on scroll idle and when leaving a session, restored on return. When IndexedDB is unavailable (private mode,
 * blocked storage) a page-lifetime map stands in. Bounded: the oldest entries beyond MAX are pruned.
 */

export interface ViewState {
  anchorSeq: number
  /** VirtualList anchor offset: row top minus scrollTop (≤ 0 when the row starts above the viewport). */
  offsetPx: number
  pinned: boolean
  savedUtc: number
}

const DB = 'vesper-chat'
const STORE = 'viewState'
const MAX = 300

const memory = new Map<string, ViewState>()
let dbp: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  dbp ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined)
        try {
          const req = fn(db.transaction(STORE, mode).objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      })
  )
}

export async function loadViewState(sessionUid: string): Promise<ViewState | null> {
  const hit = memory.get(sessionUid)
  if (hit) return hit
  const v = await run<ViewState>('readonly', (s) => s.get(sessionUid) as IDBRequest<ViewState>)
  if (v && typeof v.anchorSeq === 'number' && typeof v.pinned === 'boolean') {
    memory.set(sessionUid, v)
    return v
  }
  return null
}

let writes = 0

export function saveViewState(sessionUid: string, v: Omit<ViewState, 'savedUtc'>): void {
  const entry: ViewState = { ...v, savedUtc: Date.now() }
  memory.delete(sessionUid)
  memory.set(sessionUid, entry)
  if (memory.size > MAX) memory.delete(memory.keys().next().value as string)
  void run('readwrite', (s) => s.put(entry, sessionUid))
  if (++writes % 50 === 0) void prune()
}

async function prune(): Promise<void> {
  const all = await run<ViewState[]>('readonly', (s) => s.getAll() as IDBRequest<ViewState[]>)
  const keys = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())
  if (!all || !keys || all.length <= MAX) return
  const order = keys.map((k, i) => ({ k, t: all[i]?.savedUtc ?? 0 })).sort((a, b) => a.t - b.t)
  for (const { k } of order.slice(0, all.length - MAX)) void run('readwrite', (s) => s.delete(k))
}
