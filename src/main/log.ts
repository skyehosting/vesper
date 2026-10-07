/**
 * The shell's own small log (`<local>\logs\main.log`, 5 MB × 3) for what happens before and around the server — the
 * server has its own redacting logger (07 B10). Never pass secrets, cookies or message text here.
 */
import fs from 'node:fs'
import path from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3
let file: string | null = null

/** Start writing to `<logsDir>\main.log` (before that, the console only). */
export function setLogDir(logsDir: string): void {
  try {
    fs.mkdirSync(logsDir, { recursive: true })
    file = path.join(logsDir, 'main.log')
  } catch {
    file = null
  }
}

function rotate(f: string): void {
  try {
    if (fs.statSync(f).size < MAX_BYTES) return
  } catch {
    return
  }
  for (let i = KEEP - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${f}.${i}`, `${f}.${i + 1}`)
    } catch {
      /* missing */
    }
  }
  try {
    fs.renameSync(f, `${f}.1`)
  } catch {
    /* in use */
  }
}

function describe(data: unknown): string {
  if (data === undefined) return ''
  if (data instanceof Error) return ` ${data.name}: ${data.message}`
  try {
    return ` ${JSON.stringify(data)}`
  } catch {
    return ` ${String(data)}`
  }
}

function write(level: Level, scope: string, msg: string, data?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${describe(data)}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  if (!file) return
  try {
    rotate(file)
    fs.appendFileSync(file, line + '\n')
  } catch {
    /* logging must never break the app */
  }
}

export interface MainLog {
  debug(msg: string, data?: unknown): void
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
}

export function createLog(scope: string): MainLog {
  return {
    debug: (m, d) => write('debug', scope, m, d),
    info: (m, d) => write('info', scope, m, d),
    warn: (m, d) => write('warn', scope, m, d),
    error: (m, d) => write('error', scope, m, d)
  }
}
