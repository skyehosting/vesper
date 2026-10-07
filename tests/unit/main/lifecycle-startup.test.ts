import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { VesperError } from '@shared/errors'
import { autoAnswer, type DialogSpec } from '../../../src/main/dialogSpec'
import { parsePort, parseSize, parseTestEnv, parseWindowPos } from '../../../src/main/env'
import { closeAction, isBackgroundLaunch, isDarkTheme, warmDelayMs } from '../../../src/main/lifecycle'
import { resolveDirs } from '../../../src/main/paths'
import { classifyStartupError, MAX_START_ATTEMPTS, startWithRecovery } from '../../../src/main/startup'
import { buildTrayTemplate, starPixels } from '../../../src/main/trayModel'

describe('test switches', () => {
  it('parses sizes, positions and ports strictly', () => {
    expect(parseSize('1440x900')).toEqual({ width: 1440, height: 900 })
    expect(parseSize('1440X900')).toBeNull()
    expect(parseSize('0x900')).toBeNull()
    expect(parseWindowPos('corner')).toEqual({ kind: 'corner' })
    expect(parseWindowPos('-1280,40')).toEqual({ kind: 'point', x: -1280, y: 40 })
    expect(parseWindowPos('10;20')).toBeNull()
    expect(parsePort('0')).toBe(0)
    expect(parsePort('70000')).toBeNull()
    expect(parsePort('41730x')).toBeNull()
  })
  it('reads the documented variables', () => {
    const t = parseTestEnv({
      VESPER_DATA_DIR: 'C:\\tmp\\d',
      VESPER_PORT: '0',
      VESPER_WINDOW_SIZE: '390x844',
      VESPER_CLICK_THROUGH: '1',
      VESPER_FAKE_NOW: '1791216180000',
      VESPER_FAKE_MIC: 'tests/fixtures/audio/hello.wav'
    })
    expect(t).toMatchObject({ dataDir: 'C:\\tmp\\d', port: 0, windowSize: { width: 390, height: 844 }, clickThrough: true, fakeNow: 1791216180000, mute: true })
    expect(parseTestEnv({ VESPER_MUTE: '0' }).mute).toBe(false)
    expect(parseTestEnv({}).dataDir).toBeNull()
  })
})

describe('resolveDirs', () => {
  const base = { defaultUserData: 'C:\\Users\\o\\AppData\\Roaming\\Vesper', localAppData: 'C:\\Users\\o\\AppData\\Local', home: 'C:\\Users\\o' }
  it('keeps data and the Chromium profile (safeStorage key) in roaming; models, logs and caches local', () => {
    const d = resolveDirs({ ...base, test: null })
    expect(d.dataDir).toBe(path.resolve(base.defaultUserData))
    expect(d.localDir).toBe(path.resolve('C:\\Users\\o\\AppData\\Local\\Vesper'))
    expect(d.sessionDataDir).toBe(d.dataDir)
    expect(d.cacheDir).toBe(path.join(d.localDir, 'cache'))
    expect(d.logsDir).toBe(path.join(d.localDir, 'logs'))
    expect(d.modelsDir).toBe(path.join(d.localDir, 'models'))
  })
  it('keeps a test with its own data dir out of the real profile', () => {
    const test = parseTestEnv({ VESPER_DATA_DIR: 'C:\\tmp\\run1' })
    const d = resolveDirs({ ...base, test })
    expect(d.dataDir).toBe(path.resolve('C:\\tmp\\run1'))
    expect(d.localDir).toBe(path.resolve('C:\\tmp\\run1\\local'))
    const d2 = resolveDirs({ ...base, test: parseTestEnv({ VESPER_DATA_DIR: 'C:\\tmp\\a', VESPER_LOCAL_DIR: 'C:\\tmp\\b' }) })
    expect(d2.localDir).toBe(path.resolve('C:\\tmp\\b'))
  })
})

describe('lifecycle decisions', () => {
  it('detects background launches', () => {
    expect(isBackgroundLaunch(['Vesper.exe', '--background'])).toBe(true)
    expect(isBackgroundLaunch(['Vesper.exe'])).toBe(false)
  })
  it('hides to the tray only when asked or started in the background', () => {
    expect(closeAction({ quitting: false, closeToTray: true, background: false })).toBe('hide')
    expect(closeAction({ quitting: false, closeToTray: false, background: true })).toBe('hide')
    expect(closeAction({ quitting: false, closeToTray: false, background: false })).toBe('close')
    expect(closeAction({ quitting: true, closeToTray: true, background: true })).toBe('close')
  })
  it('maps keepWindowWarmSec to a delay', () => {
    expect(warmDelayMs(30)).toBe(30_000)
    expect(warmDelayMs(0)).toBe(0)
    expect(warmDelayMs(-1)).toBeNull()
    expect(warmDelayMs(undefined)).toBe(30_000)
  })
  it('picks the theme', () => {
    expect(isDarkTheme('dark', false)).toBe(true)
    expect(isDarkTheme('light', true)).toBe(false)
    expect(isDarkTheme('system', false)).toBe(false)
    expect(isDarkTheme(undefined, false)).toBe(true)
  })
})

describe('startup recovery', () => {
  const busy = Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:41730'), { code: 'EADDRINUSE' })

  it('classifies bind failures', () => {
    expect(classifyStartupError(busy)).toBe('port')
    expect(classifyStartupError(new VesperError('port_unavailable'))).toBe('port')
    expect(classifyStartupError(new Error('wrapped', { cause: busy }))).toBe('port')
    expect(classifyStartupError(new Error('startServer: not implemented yet'))).toBe('other')
    expect(classifyStartupError('boom')).toBe('other')
  })

  it('retries on any free port after "Choose another port"', async () => {
    const ports: (number | undefined)[] = []
    const asked: DialogSpec[] = []
    const r = await startWithRecovery({
      start: async (port) => {
        ports.push(port)
        if (ports.length === 1) throw busy
        return 'server'
      },
      ask: async (spec) => {
        asked.push(spec)
        return 0
      }
    })
    expect(r).toBe('server')
    expect(ports).toEqual([undefined, 0])
    expect(asked[0].buttons).toEqual(['Choose another port', 'Quit'])
  })

  it('resolves null when the owner quits (the automatic answer in test mode)', async () => {
    const start = vi.fn(async () => {
      throw new Error('startServer: not implemented yet (server-core)')
    })
    const r = await startWithRecovery({ start, ask: async (spec) => autoAnswer(spec, null) })
    expect(r).toBeNull()
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('gives up after a bounded number of attempts', async () => {
    const start = vi.fn(async () => {
      throw new Error('nope')
    })
    const asked: DialogSpec[] = []
    const r = await startWithRecovery({
      start,
      ask: async (spec) => {
        asked.push(spec)
        return 0
      }
    })
    expect(r).toBeNull()
    expect(start).toHaveBeenCalledTimes(MAX_START_ATTEMPTS)
    expect(asked.at(-1)?.buttons).toEqual(['Quit'])
  })

  it('answers dialogs automatically by index or label', () => {
    const spec = { buttons: ['Choose another port', 'Quit'], cancelId: 1 }
    expect(autoAnswer(spec, null)).toBe(1)
    expect(autoAnswer(spec, '0')).toBe(0)
    expect(autoAnswer(spec, 'choose another port')).toBe(0)
    expect(autoAnswer(spec, '7')).toBe(1)
  })
})

describe('tray model', () => {
  it('builds Open / sections / Quit and skips failing providers', () => {
    const onError = vi.fn()
    const t = buildTrayTemplate(
      { onOpen: () => undefined, onQuit: () => undefined },
      [
        ['access', () => [{ label: 'Copy LAN link' }]],
        ['broken', () => {
          throw new Error('x')
        }],
        ['empty', () => []]
      ],
      onError
    )
    expect(t.map((i) => i.label ?? i.type)).toEqual(['Open Vesper', 'separator', 'Copy LAN link', 'separator', 'Quit Vesper'])
    expect(onError).toHaveBeenCalledWith('broken', expect.any(Error))
  })
  it('draws an opaque centre and transparent corners', () => {
    const px = starPixels(32)
    expect(px.length).toBe(32 * 32 * 4)
    const alpha = (x: number, y: number): number => px[(y * 32 + x) * 4 + 3]
    expect(alpha(16, 16)).toBeGreaterThan(200)
    expect(alpha(0, 0)).toBe(0)
    expect(alpha(31, 31)).toBe(0)
  })
})
