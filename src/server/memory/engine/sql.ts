/** SQL helpers for db.worker: prepared-statement cache, BigInt binding (research 03 §1), chunked IN lists, yields. */
import type { StatementSync } from 'node:sqlite'
import type { Db } from '../../db/sqlite'

export type Row = Record<string, unknown>

export const big = (n: number | bigint): bigint => (typeof n === 'bigint' ? n : BigInt(Math.trunc(n)))
export const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : (v as number))

/** Prepared statements by SQL text (bounded: the SQL set is static apart from IN-list arities, which are capped). */
export class Stmts {
  private cache = new Map<string, StatementSync>()
  constructor(readonly db: Db) {}

  get(sql: string): StatementSync {
    let s = this.cache.get(sql)
    if (!s) {
      if (this.cache.size > 256) this.cache.clear()
      s = this.db.prepare(sql)
      this.cache.set(sql, s)
    }
    return s
  }

  get size(): number {
    return this.cache.size
  }

  clear(): void {
    this.cache.clear()
  }
}

/** `?, ?, ?` for n parameters. */
export function marks(n: number): string {
  return new Array(n).fill('?').join(',')
}

export function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Let queued messages (searches, cancels) run between write transactions (07 C9: ≤ 20 ms slices). */
export function yieldNow(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

/** BEGIN IMMEDIATE … COMMIT with rollback on error (the worker never nests transactions). */
export function writeTx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back */
    }
    throw e
  }
}
