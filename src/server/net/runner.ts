/**
 * The one way access-server runs external programs (tailscale, PowerShell, netsh). Every command is classified:
 *   probe   — read-only (tailscale version/status, firewall rule listing)
 *   mutate  — changes system state without elevation (tailscale serve/funnel on/off)
 *   elevate — needs ONE UAC prompt the owner asked for (firewall allow); only from the desktop's explicit click
 * The runner is injected: tests use a recording fake; test mode (__VESPER_TEST__ && VESPER_TEST=1) uses the dry runner,
 * which records and never executes anything, so no test or dev run can touch the system. Children run hidden
 * (`windowsHide`, nothing flashes on the owner's primary display), with a timeout and an output cap, and are killed
 * on close.
 */
import { execFile, type ChildProcess } from 'node:child_process'

export type CommandKind = 'probe' | 'mutate' | 'elevate'

export interface Command {
  kind: CommandKind
  file: string
  args: string[]
  timeoutMs?: number
}

export interface CommandResult {
  /** Exit code; null when the program could not start (`error` says why) or was killed. */
  code: number | null
  stdout: string
  stderr: string
  error?: 'ENOENT' | 'TIMEOUT' | 'FAILED'
}

export interface CommandRunner {
  run(cmd: Command): Promise<CommandResult>
  /** Kill running children (server shutdown). */
  close(): void
}

const MAX_OUTPUT = 1024 * 1024
const DEFAULT_TIMEOUT: Record<CommandKind, number> = { probe: 8_000, mutate: 20_000, elevate: 120_000 }

export function createRealRunner(): CommandRunner {
  const children = new Set<ChildProcess>()
  let closed = false
  return {
    run(cmd) {
      if (closed) return Promise.resolve({ code: null, stdout: '', stderr: '', error: 'FAILED' })
      return new Promise((resolve) => {
        const child = execFile(
          cmd.file,
          cmd.args,
          { windowsHide: true, timeout: cmd.timeoutMs ?? DEFAULT_TIMEOUT[cmd.kind], maxBuffer: MAX_OUTPUT, encoding: 'utf8' },
          (err, stdout, stderr) => {
            children.delete(child)
            if (!err) return resolve({ code: 0, stdout, stderr })
            const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean }
            if (e.code === 'ENOENT') return resolve({ code: null, stdout: '', stderr: '', error: 'ENOENT' })
            if (e.killed) return resolve({ code: null, stdout, stderr, error: 'TIMEOUT' })
            resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout, stderr })
          }
        )
        children.add(child)
      })
    },
    close() {
      closed = true
      for (const c of children) c.kill()
      children.clear()
    }
  }
}

/**
 * Test-mode runner: records every command (bounded) and executes nothing. Probes answer "not installed" unless a
 * script matches; mutations and elevations "succeed".
 */
export interface DryRunner extends CommandRunner {
  readonly commands: Command[]
  script(match: (c: Command) => boolean, result: CommandResult): void
}

export function createDryRunner(): DryRunner {
  const commands: Command[] = []
  const scripts: { match: (c: Command) => boolean; result: CommandResult }[] = []
  return {
    commands,
    script(match, result) {
      scripts.unshift({ match, result })
    },
    async run(cmd) {
      commands.push(cmd)
      if (commands.length > 200) commands.splice(0, commands.length - 200)
      const s = scripts.find((x) => x.match(cmd))
      if (s) return s.result
      return cmd.kind === 'probe' ? { code: null, stdout: '', stderr: '', error: 'ENOENT' } : { code: 0, stdout: '', stderr: '' }
    },
    close() {
      scripts.length = 0
    }
  }
}

/** PowerShell's -EncodedCommand (UTF-16LE base64): no quoting rules between Node, CreateProcess and PowerShell. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** A PowerShell single-quoted string literal. */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}
