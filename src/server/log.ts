/**
 * Server log (07 B10): JSON lines in `<local>\logs\vesper.log`, rotated at 5 MB × 3, plus the console in dev.
 * Everything passes through `redact()`: auth headers, cookies and key-shaped strings never reach disk. Callers must not
 * log request/response bodies or message text (only "Diagnostic logging" may, and that is the caller's decision).
 * Writes are synchronous on purpose: lines are small and rare, and a crash must not lose the line that explains it.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Log } from './services'

type Level = 'debug' | 'info' | 'warn' | 'error'
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const SECRET_KEYS = /^(authorization|proxy-authorization|x-api-key|xi-api-key|api-key|apikey|api_key|cookie|set-cookie|password|passwd|secret|token|access_token|refresh_token|key|value)$/i
/**
 * Key-shaped strings (07 B10, widened by F06): the prefix may be followed by '-' or '_' — ElevenLabs keys are `sk_…`
 * and Groq keys `gsk_…`. The separator is kept so the log still shows which kind of key it was.
 */
const KEY_SHAPED = /\b(sk|pa|al|gsk|xai)([-_])[A-Za-z0-9_-]{8,}/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi
/** Deepgram's `Authorization: Token <key>`. Case-sensitive and long, so prose like "token received" stays readable. */
const TOKEN_SCHEME = /\b(Token)\s+[A-Za-z0-9._~+/=-]{16,}/g
const SID_COOKIE = /(__Host-vesper_sid=)[^;\s]+/g

/** Redact secrets from any value (deep). Exported for tests and for code that formats its own strings. */
export function redact(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return redactString(v)
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? String(v) : v
  if (depth > 6) return '[…]'
  if (v instanceof Error) return { name: v.name, message: redactString(v.message), code: (v as { code?: unknown }).code }
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(x, depth + 1)
  return out
}

export function redactString(s: string): string {
  return s
    .replace(KEY_SHAPED, '$1$2[redacted]')
    .replace(BEARER, '$1 [redacted]')
    .replace(TOKEN_SCHEME, '$1 [redacted]')
    .replace(SID_COOKIE, '$1[redacted]')
}

export interface LogOptions {
  dir: string
  console?: boolean
  level?: Level
  /** Rotation size (default 5 MB) and number of files kept (default 3, including the current one). */
  maxBytes?: number
  files?: number
}

export interface FileLog extends Log {
  close(): void
}

export function createLog(o: LogOptions): FileLog {
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024
  const files = Math.max(1, o.files ?? 3)
  const minLevel = LEVELS[o.level ?? 'debug']
  const file = path.join(o.dir, 'vesper.log')
  let fd: number | null = null
  let size = 0
  let failed = false

  function open(): void {
    try {
      fs.mkdirSync(o.dir, { recursive: true })
      fd = fs.openSync(file, 'a')
      size = fs.fstatSync(fd).size
    } catch {
      failed = true // A read-only or full disk must not take the server down; the console still works.
    }
  }

  function rotate(): void {
    if (fd !== null) fs.closeSync(fd)
    fd = null
    for (let i = files - 1; i >= 1; i--) {
      const from = i === 1 ? file : path.join(o.dir, `vesper.${i - 1}.log`)
      const to = path.join(o.dir, `vesper.${i}.log`)
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to)
      } catch {
        /* best effort */
      }
    }
    if (files === 1) fs.rmSync(file, { force: true })
    open()
  }

  function write(level: Level, scope: string, msg: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < minLevel) return
    const entry: Record<string, unknown> = { t: new Date().toISOString(), level, scope: scope || undefined, msg: redactString(msg) }
    if (data) entry.data = redact(data)
    const line = `${JSON.stringify(entry)}\n`
    if (o.console) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fn(`[${level}]${scope ? ` ${scope}:` : ''} ${entry.msg as string}`, entry.data ?? '')
    }
    if (failed) return
    if (fd === null) open()
    if (fd === null) return
    const bytes = Buffer.byteLength(line)
    if (size + bytes > maxBytes && size > 0) rotate()
    if (fd === null) return
    try {
      fs.writeSync(fd, line)
      size += bytes
    } catch {
      failed = true
    }
  }

  function make(scope: string): Log {
    return {
      debug: (m, d) => write('debug', scope, m, d),
      info: (m, d) => write('info', scope, m, d),
      warn: (m, d) => write('warn', scope, m, d),
      error: (m, d) => write('error', scope, m, d),
      child: (s) => make(scope ? `${scope}.${s}` : s)
    }
  }

  return {
    ...make(''),
    close() {
      if (fd !== null) fs.closeSync(fd)
      fd = null
      failed = true
    }
  }
}
