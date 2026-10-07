/** A `Log` that keeps every line in memory, so tests can assert on (and against) what would be logged. */
import type { Log } from '../../src/server/services'

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  scope: string
  msg: string
  data?: Record<string, unknown>
}

export interface FakeLog extends Log {
  readonly entries: LogEntry[]
  /** Every line as text (message + JSON data), for "never logs X" assertions. */
  text(): string
}

export function fakeLog(scope = 'test', entries: LogEntry[] = []): FakeLog {
  const at =
    (level: LogEntry['level']) =>
    (msg: string, data?: Record<string, unknown>): void => {
      entries.push({ level, scope, msg, data })
    }
  return {
    entries,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (s: string) => fakeLog(`${scope}.${s}`, entries),
    text: () => entries.map((e) => `${e.level} ${e.scope} ${e.msg}${e.data ? ` ${JSON.stringify(e.data)}` : ''}`).join('\n')
  }
}
