/** Small helpers shared by the repositories. */
import { tx, type Db } from '../sqlite'

/**
 * Run `fn` atomically. Outside a transaction this is BEGIN IMMEDIATE (writers queue on busy_timeout); inside one
 * (a repository method called from another, or from a caller's own transaction) it nests with a savepoint.
 */
export function atomic<T>(db: Db, fn: () => T): T {
  if (!db.isTransaction) return tx(db, fn)
  const name = `sp_${++savepointSeq}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const r = fn()
    db.exec(`RELEASE ${name}`)
    return r
  } catch (e) {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
    throw e
  }
}
let savepointSeq = 0

export type SqlRow = Record<string, unknown>

/** INTEGER column → number (node:sqlite returns numbers unless readBigInts is on, but be tolerant). */
export function n(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : (v as number)
}

export function nOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : n(v)
}

/** INTEGER id column → bigint (internal ids are bigint, research 03 §1). */
export function big(v: unknown): bigint {
  return typeof v === 'bigint' ? v : BigInt(v as number)
}

export function bigOrNull(v: unknown): bigint | null {
  return v === null || v === undefined ? null : big(v)
}

export function bool(v: unknown): boolean {
  return n(v) !== 0
}

export function str(v: unknown): string {
  return v as string
}

export function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : (v as string)
}

/** JSON columns are written by us; a corrupt value degrades to the fallback instead of failing the whole page. */
export function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v === '') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export function jsonOrNull<T>(v: unknown): T | null {
  return json<T | null>(v, null)
}

/** Build `SET a = ?, b = ?` from a column → value map (values already converted for SQLite). */
export function setClause(cols: Record<string, SqlValue>): { sql: string; values: SqlValue[] } {
  const keys = Object.keys(cols)
  return { sql: keys.map((k) => `${k} = ?`).join(', '), values: keys.map((k) => cols[k]) }
}

export type SqlValue = string | number | bigint | null | Uint8Array
