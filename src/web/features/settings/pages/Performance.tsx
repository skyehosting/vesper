/**
 * Settings → Performance: game mode (07 D3) with its live state (bootstrap, `gamemode.changed`, and each resource
 * poll), resource use (07 D2: GET /api/system/resources, polled only while this page is visible) against the memory
 * budgets, what voice parts are loaded, and "Unload voice models now" (POST /api/system/unload-voice: the speech
 * recognizer and the Windows voice host; the client drops its code highlighter when the server hints so), plus the
 * unload timers.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Gamepad2, MemoryStick, RefreshCw } from 'lucide-react'
import type { SystemResources } from '@shared/api'
import type { GameModeReason } from '@shared/ws'
import { Badge } from '../../../components/Badge'
import { Button } from '../../../components/Button'
import { disposeHighlighter } from '../../../components/code/highlighter'
import { ErrorState } from '../../../components/ErrorState'
import { ProgressBar } from '../../../components/Progress'
import { Skeleton } from '../../../components/Skeleton'
import { toast } from '../../../components/Toast'
import { api } from '../../../lib/api'
import { toApiError } from '../../../lib/errors.logic'
import { useStore } from '../../../lib/store'
import { ws } from '../../../lib/ws'
import type { SettingsSectionProps } from '../sections'
import { NumberSetting, ReadOnlyNotice, SegmentedSetting, SettingRow, SettingsAdvanced, SettingsGroup, SettingsPageHeader, SliderSetting } from '../ui'
import { budgetOf, unloadedText } from './performance.logic'

const PATHS = ['performance.gameMode']
const POLL_MS = 3000

const REASON: Record<GameModeReason, string> = {
  off: 'Off — nothing full-screen is in front.',
  forced: 'On — you turned it on.',
  fullscreen: 'On — a full-screen app is in front.',
  d3d: 'On — a game is running in exclusive full screen.',
  busy: 'On — Windows reports a presentation or game in progress.'
}

type GameState = { active: boolean; reason: GameModeReason }

/** Polls resource use every POLL_MS while the page is visible; the interval and listener die with the component. */
function useResources(): { data: SystemResources | null; error: unknown; refresh(): void } {
  const [data, setData] = useState<SystemResources | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    let timer = 0
    const ctl = new AbortController()
    const load = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return
      try {
        const r = await api('GET /api/system/resources', { signal: ctl.signal })
        if (!alive) return
        setData(r)
        setError(null)
      } catch (e) {
        if (alive && !(e instanceof DOMException && e.name === 'AbortError')) setError(e)
      }
    }
    void load()
    timer = window.setInterval(() => void load(), POLL_MS)
    const onVis = (): void => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      ctl.abort()
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [tick])
  return { data, error, refresh: () => setTick((t) => t + 1) }
}

/** Game mode as the server sees it: bootstrap, then `gamemode.changed`, refreshed by each resource poll. */
function useGameMode(polled: GameState | undefined): GameState | null {
  const initial = useStore((s) => s.bootstrap?.gameMode ?? null)
  const [state, setState] = useState<GameState | null>(initial)
  useEffect(() => ws.on('gamemode.changed', (m) => setState({ active: m.active, reason: m.reason })), [])
  useEffect(() => {
    if (polled) setState((s) => (s && s.active === polled.active && s.reason === polled.reason ? s : polled))
  }, [polled?.active, polled?.reason])
  return state
}

export default function SettingsPerformance({ advanced }: SettingsSectionProps): ReactNode {
  const res = useResources()
  const game = useGameMode(res.data?.gameMode)
  const [unloading, setUnloading] = useState(false)
  const processes = res.data?.processes ?? null
  const budget = res.data ? budgetOf(res.data) : null
  const voice = res.data?.voice

  const unload = async (): Promise<void> => {
    setUnloading(true)
    try {
      const r = await api('POST /api/system/unload-voice')
      // The server's hint: our side's own heavy helper (the code highlighter's worker) can go too; it restarts on use.
      if (r.clientHints.includes('highlighter')) disposeHighlighter()
      toast.success(unloadedText(r))
      res.refresh()
    } catch (e) {
      toast.error(toApiError(e).message)
    } finally {
      setUnloading(false)
    }
  }

  return (
    <div className="spage">
      <SettingsPageHeader title="Performance" description="Keep Vesper light while you play, and see what it uses." />
      <ReadOnlyNotice paths={PATHS} />

      <SettingsGroup title="Game mode" description="While a game runs full screen, the Star rests, voice models unload after their idle time, memory indexing pauses and notifications wait.">
        <SegmentedSetting
          setting="performance.gameMode"
          label="Game mode"
          description="Automatic turns it on when a full-screen app is in front."
          options={[
            { value: 'auto', label: 'Automatic' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' }
          ]}
        />
        <SettingRow inline>
          <div className="set-row__text">
            <span className="set-row__label">Right now</span>
            <span className="set-row__desc" role="status" data-testid="gamemode-now">
              {game ? REASON[game.reason] : 'Checking…'}
            </span>
          </div>
          <Badge tone={game?.active ? 'accent' : 'neutral'} dot icon={<Gamepad2 />}>
            {game?.active ? 'Active' : 'Inactive'}
          </Badge>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Resource use"
        description="Memory and processor use of Vesper's processes, updated every few seconds."
        actions={<Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={res.refresh}>Refresh</Button>}
      >
        {res.error && !processes ? (
          <div className="set-row">
            <ErrorState error={toApiError(res.error)} compact onRetry={res.refresh} />
          </div>
        ) : !processes ? (
          <div className="set-row" data-loading>
            <Skeleton height={18} />
            <Skeleton height={18} width="70%" />
          </div>
        ) : (
          <>
            {budget ? (
              <div className="set-row" data-testid="resource-budget">
                <ProgressBar
                  label="Memory in use"
                  value={budget.share}
                  valueText={`${budget.usedMB} MB of ${budget.budgetMB} MB`}
                  tone={budget.share > 1 ? 'danger' : budget.share > 0.85 ? 'warning' : 'success'}
                  size="sm"
                />
                <p className="set-row__desc">Compared with Vesper’s {budget.label}.</p>
              </div>
            ) : null}
            <div className="set-row">
              <table className="sres" data-testid="resource-table">
                <caption className="sr-only">Vesper processes</caption>
                <thead>
                  <tr>
                    <th scope="col">Process</th>
                    <th scope="col" className="num">
                      Memory
                    </th>
                    <th scope="col" className="num">
                      Processor
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {processes.map((p) => (
                    <tr key={p.pid}>
                      <th scope="row">
                        {p.name}
                        {p.type && !p.name.toLowerCase().includes(p.type.toLowerCase()) ? <span className="sres__type"> · {p.type}</span> : null}
                      </th>
                      <td className="num tabular">{(p.privateMB ?? p.memMB).toFixed(0)} MB</td>
                      <td className="num tabular">{p.cpu.toFixed(1)} %</td>
                    </tr>
                  ))}
                </tbody>
                {processes.length > 1 ? (
                  <tfoot>
                    <tr>
                      <th scope="row">Total</th>
                      <td className="num tabular">{(res.data?.totalMB ?? processes.reduce((n, p) => n + (p.privateMB ?? p.memMB), 0)).toFixed(0)} MB</td>
                      <td />
                    </tr>
                  </tfoot>
                ) : null}
              </table>
            </div>
          </>
        )}
        <SettingRow inline>
          <div className="set-row__text">
            <span className="set-row__label">Voice models</span>
            <span className="set-row__desc" data-testid="voice-loaded">
              {voice
                ? `${voice.sttLoaded ? 'Speech recognition is loaded (about 700 MB).' : 'Speech recognition is not loaded.'} ${voice.winttsRunning ? 'The Windows voice host is running.' : 'The Windows voice host is not running.'}`
                : 'Speech recognition holds about 700 MB while loaded.'}{' '}
              Unloading frees them now; they load again when next used.
            </span>
          </div>
          <Button icon={<MemoryStick />} loading={unloading} onClick={() => void unload()}>
            Unload voice models now
          </Button>
        </SettingRow>
        <SliderSetting
          setting="voice.stt.unloadAfterMin"
          label="Unload the speech model after"
          step={1}
          format={(v) => (v === 0 ? 'Right after use' : `${v} min idle`)}
          hint="Frees its memory when the microphone hasn't been used for this long."
        />
      </SettingsGroup>

      <SettingsAdvanced open={advanced}>
        <SettingsGroup>
          <NumberSetting setting="desktop.keepWindowWarmSec" label="Keep the closed window ready for" unit="seconds" hint="Reopening from the tray is instant within this time; afterwards the window's memory is freed. −1 keeps it ready." />
          <SliderSetting setting="voice.tts.localUnloadAfterMin" label="Unload a local voice after" step={1} format={(v) => (v === 0 ? 'Right after use' : `${v} min idle`)} />
        </SettingsGroup>
      </SettingsAdvanced>
    </div>
  )
}
