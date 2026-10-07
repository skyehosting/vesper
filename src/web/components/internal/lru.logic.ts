/**
 * A small LRU map (07 D7: highlighted code is cached by content hash, 500 entries) and a fast string hash for keys.
 * Map iteration order is insertion order, so "touch" = delete + set and the oldest entry is the first key.
 */

export class Lru<K, V> {
  private readonly map = new Map<K, V>()
  constructor(readonly capacity: number) {
    if (!(capacity > 0)) throw new Error('Lru capacity must be > 0')
  }

  get size(): number {
    return this.map.size
  }

  get(key: K): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, value)
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as K
      this.map.delete(oldest)
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  keys(): K[] {
    return [...this.map.keys()]
  }
}

/** cyrb53: a 53-bit string hash (fast, well distributed; not cryptographic). Returned as base-36 text. */
export function hashString(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
