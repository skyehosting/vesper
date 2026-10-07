/** A fake system-state host (resources/sysstate.ps1) for game-mode tests: the test pushes state lines. */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { HostProcess, HostSpawn } from '@server/providers/tts/winttsHost'
import type { SysState } from '@server/system/sysstateHost'

export const DESKTOP: SysState = { quns: 5, fg: true, covers: false, caption: true, shell: false, pid: 4242, cls: 'Chrome_WidgetWin_1' }
export const GAME: SysState = { quns: 5, fg: true, covers: true, caption: false, shell: false, pid: 5151, cls: 'UnityWndClass' }
export const D3D: SysState = { ...DESKTOP, quns: 3, pid: 6161 }

export class FakeSysProc extends EventEmitter implements HostProcess {
  static next = 7000
  readonly pid = FakeSysProc.next++
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly lines: string[] = []
  ended = false
  exited = false
  killed = false
  /** Ignore stdin EOF (a stuck host: close must kill it). */
  ignoreEof = false
  readonly stdin: HostProcess['stdin']
  constructor(readonly args: string[]) {
    super()
    this.stdin = {
      write: (s: string) => {
        this.lines.push(...s.split('\n').filter(Boolean))
        return true
      },
      end: () => {
        this.ended = true
        if (!this.ignoreEof) setTimeout(() => this.exit(0), 2)
      },
      on: () => this.stdin
    }
    setTimeout(() => this.write({ t: 'ready', pid: this.pid }), 1)
  }
  write(o: unknown): void {
    if (!this.exited) this.stdout.write(`${JSON.stringify(o)}\n`)
  }
  state(s: SysState): void {
    this.write({ t: 'state', ...s })
  }
  exit(code: number | null): void {
    if (this.exited) return
    this.exited = true
    this.emit('exit', code)
  }
  kill(): boolean {
    this.killed = true
    setTimeout(() => this.exit(null), 1)
    return true
  }
}

export function fakeSysRunner(): { spawn: HostSpawn; procs: FakeSysProc[]; last(): FakeSysProc } {
  const procs: FakeSysProc[] = []
  return {
    procs,
    spawn: (cmd, args) => {
      if (cmd !== 'powershell.exe' || !args.some((a) => a.endsWith('sysstate.ps1'))) throw new Error(`unexpected spawn ${cmd} ${args.join(' ')}`)
      const p = new FakeSysProc(args)
      procs.push(p)
      return p
    },
    last: () => {
      const p = procs[procs.length - 1]
      if (!p) throw new Error('no host spawned')
      return p
    }
  }
}

export const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function until(pred: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`)
    await wait(5)
  }
}
