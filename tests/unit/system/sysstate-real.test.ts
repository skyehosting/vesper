/**
 * The real system-state host on this PC (Windows only; skipped elsewhere). Safe: resources/sysstate.ps1 is READ-ONLY
 * (it only queries the foreground window and the notification state). Checks: a well-formed state line arrives, a
 * probe request is answered, stdin EOF ends the process (no orphaned powershell.exe). @R14
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SysStateHost, type SysState } from '@server/system/sysstateHost'
import { fakeLog } from '../../fakes'
import { until, wait } from './fakeHost'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(process.platform !== 'win32')('real sysstate.ps1 host', () => {
  it('reports the foreground state, answers a probe, exits on stdin EOF', async () => {
    const states: SysState[] = []
    const h = new SysStateHost({ script: path.resolve('resources', 'sysstate.ps1'), log: fakeLog(), intervalMs: 250, onState: (s) => states.push(s) })
    h.start()
    await until(() => states.length >= 1, 15_000, 'first state line')
    const pid = h.pid!
    expect(pid).toBeGreaterThan(0)
    const s = states[0]
    expect(typeof s.quns).toBe('number')
    expect(s.quns).toBeGreaterThanOrEqual(0)
    expect(typeof s.covers).toBe('boolean')
    expect(typeof s.caption).toBe('boolean')
    h.probe()
    await until(() => states.length >= 2, 5000, 'probe answer')
    await h.stop()
    await wait(300)
    expect(alive(pid)).toBe(false)
    // And no powershell.exe running sysstate.ps1 is left (by command line: Windows reuses pids quickly, so a pid
    // alone could match the very powershell.exe that runs this query).
    const list = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `@(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Where-Object { $_.CommandLine -like '*sysstate.ps1*' }).Count`],
      { encoding: 'utf8', windowsHide: true }
    )
    expect(list.trim()).toBe('0')
  }, 30_000)
})
