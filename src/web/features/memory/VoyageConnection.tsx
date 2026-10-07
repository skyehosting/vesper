/**
 * Voyage AI connection controls (Settings → Memory and wizard step 3, 07 D11): the key (write-only SecretInput →
 * PUT /api/secrets/voyage, validated by the server with a real 256-dim embed; a wrong key is refused with Voyage's
 * reason), Test (POST /api/providers/voyage/test, 10 s client timeout), and the model + dimensions from the bundled
 * catalogue (voyage.logic.ts). A model family or dimension change makes the server rebuild the index in the
 * background (07 C10), so it is confirmed first.
 */
import { useRef, useState, type ReactNode } from 'react'
import { CircleCheck, CircleAlert, PlugZap } from 'lucide-react'
import type { ProviderTestResult } from '@shared/types/domain'
import { Button } from '../../components/Button'
import { Segmented } from '../../components/Segmented'
import { Select } from '../../components/Select'
import { SecretInput } from '../../components/SecretInput'
import { useConfirm } from '../../components/ConfirmDialog'
import { api } from '../../lib/api'
import { ApiErrorException, toApiError } from '../../lib/errors.logic'
import { Row } from './layout'
import { markSecret, patchSettings, useIsDesktop, usePatchSettings, useSecretSet, useSettings, voyageKeyKnown } from './settings'
import { useLive } from './live'
import { memoryStatus } from './stores'
import { baseUrlForKey, DIMENSIONS, EMBED_CHOICES, needsRebuild, voyageKeyProblem, type Dimension } from './voyage.logic'
import { formatCount } from './format.logic'
import { cx } from './cx'

export const TEST_TIMEOUT_MS = 10_000

/** Test the saved (or a typed) key; resolves a result even on timeout/failure (never throws). */
export async function testVoyage(body: { key?: string; model?: string } = {}): Promise<ProviderTestResult> {
  const ctl = new AbortController()
  const timer = window.setTimeout(() => ctl.abort(), TEST_TIMEOUT_MS)
  try {
    return await api('POST /api/providers/voyage/test', { body, signal: ctl.signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError')
      return { ok: false, kind: 'network', message: 'Voyage AI didn’t answer within 10 seconds. Check your connection and try again.' }
    return { ok: false, kind: 'unknown', message: toApiError(e).message }
  } finally {
    window.clearTimeout(timer)
  }
}

export function TestResult({ result }: { result: ProviderTestResult | null }): ReactNode {
  if (!result) return null
  const good = result.ok
  return (
    <p className={cx('vtest', good ? 'vtest--ok' : 'vtest--bad', result.kind === 'rate' && 'vtest--warn')} role="status" data-testid="voyage-test-result">
      {good ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <span>{result.message}</span>
    </p>
  )
}

/** Key + Test. `onSaved` runs after a key was accepted (the wizard moves on; settings may offer backfill). */
export function VoyageKey({ onSaved, autoTest = true }: { onSaved?: () => void; autoTest?: boolean }): ReactNode {
  const { saved: secretSaved, invalid } = useSecretSet('voyage')
  const { data: status } = useLive(memoryStatus)
  const saved = voyageKeyKnown(secretSaved, status?.state)
  const settings = useSettings()
  const desktop = useIsDesktop()
  const [result, setResult] = useState<ProviderTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const runId = useRef(0)

  const runTest = async (): Promise<void> => {
    const my = ++runId.current
    setTesting(true)
    setResult(null)
    const r = await testVoyage()
    if (my !== runId.current) return
    setTesting(false)
    setResult(r)
  }

  const save = async (key: string): Promise<void> => {
    // Atlas keys (al-…) belong to MongoDB's endpoint: move the base URL first, then bind the key to it (07 B1).
    const current = settings?.memory.voyage.baseUrl ?? ''
    const custom = settings?.memory.voyage.customEndpoint ?? false
    const want = custom ? current : baseUrlForKey(key)
    if (!custom && safeOrigin(want) !== safeOrigin(current)) await patchSettings({ memory: { voyage: { baseUrl: want } } })
    try {
      await api('PUT /api/secrets/:name', { params: { name: 'voyage' }, body: { value: key, forUrl: want } })
    } catch (e) {
      // Voyage refused the key: show its reason in the field (SecretInput keeps the typed value).
      if (e instanceof ApiErrorException) throw e
      throw new ApiErrorException(toApiError(e), 0)
    }
    markSecret('voyage', true)
    onSaved?.()
    if (autoTest) void runTest()
  }

  const remove = async (): Promise<void> => {
    await api('DELETE /api/secrets/:name', { params: { name: 'voyage' } })
    markSecret('voyage', false)
    setResult(null)
  }

  return (
    <div className="vkey" data-secret="voyage">
      <SecretInput
        label="Voyage AI API key"
        saved={saved}
        onSave={save}
        onRemove={remove}
        validate={voyageKeyProblem}
        disabled={!desktop}
        error={invalid ? 'The saved key can’t be read on this Windows account. Paste it again.' : undefined}
        hint={
          <>
            From <span className="mono">dash.voyageai.com</span> → API keys (or MongoDB Atlas → AI models). It is stored encrypted on this PC and only ever sent
            to Voyage.
          </>
        }
      />
      <div className="vkey__test">
        <Button size="sm" icon={<PlugZap />} loading={testing} disabled={!saved || !desktop} onClick={() => void runTest()}>
          Test connection
        </Button>
        <TestResult result={result} />
      </div>
    </div>
  )
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin
  } catch {
    return ''
  }
}

/** Model + dimensions rows. `indexed` = vectors in the current index (for the rebuild warning). */
export function VoyageModelRows({ indexed, disabled }: { indexed: number; disabled?: boolean }): ReactNode {
  const settings = useSettings()
  const patch = usePatchSettings()
  const { confirm, dialog } = useConfirm()
  if (!settings) return null
  const v = settings.memory.voyage
  const change = async (to: { model: string; dim: number }): Promise<void> => {
    if (needsRebuild({ model: v.embedModel, dim: v.dim }, to) && indexed > 0) {
      const ok = await confirm({
        title: 'Rebuild the memory index?',
        description: `This model or size uses a different kind of numbers, so Vesper will index your ${formatCount(indexed)} remembered messages again in the background. Search keeps using the current index until the new one is ready.`,
        confirmLabel: 'Rebuild'
      })
      if (!ok) return
    }
    await patch({ memory: { voyage: { embedModel: to.model, dim: to.dim as Dimension } } })
  }
  return (
    <>
      <Row
        setting="memory.voyage.embedModel"
        label="Model"
        description="voyage-4 models share one index, so switching between them is instant."
        control={
          <Select
            label="Model"
            labelHidden
            value={v.embedModel}
            disabled={disabled}
            onChange={(m) => void change({ model: m, dim: v.dim })}
            options={EMBED_CHOICES.map((m) => ({ value: m.id, label: m.label, description: m.description, meta: `$${m.usdPerMTok.toFixed(2)} / 1M tokens` }))}
            className="vmodel__select"
          />
        }
      />
      <Row
        setting="memory.voyage.dim"
        label="Detail"
        description="How many numbers describe each message. 1024 is a good balance; smaller is faster and uses less disk."
        control={
          <Segmented
            aria-label="Detail (dimensions)"
            size="sm"
            value={String(v.dim)}
            disabled={disabled}
            onChange={(d) => void change({ model: v.embedModel, dim: Number(d) })}
            options={DIMENSIONS.map((d) => ({ value: String(d), label: String(d) }))}
          />
        }
      />
      {dialog}
    </>
  )
}
