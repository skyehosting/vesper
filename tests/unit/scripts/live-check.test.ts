/**
 * scripts/live-check.mjs (07 E10, review F41): runs nothing without keys; with keys it checks every provider and
 * prints a report — exercised here against the test mocks (LIVE_CHECK_MOCK_BASE), never real services. Keys are
 * never printed.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startMockServer, type MockServer } from '../../mocks/server'

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'live-check.mjs')
let mock: MockServer

beforeAll(async () => {
  mock = await startMockServer()
})
afterAll(async () => {
  await mock?.close()
})

function run(env: Record<string, string>, args: string[] = []): Promise<{ code: number | null; out: string }> {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/_API_KEY$|_MODEL$|^LIVE_CHECK/.test(k)) base[k] = v
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env: { ...base, ELECTRON_RUN_AS_NODE: '1', ...env }, cwd: path.dirname(SCRIPT) })
    let out = ''
    p.stdout.on('data', (d) => (out += String(d)))
    p.stderr.on('data', (d) => (out += String(d)))
    p.on('exit', (code) => resolve({ code, out }))
  })
}

describe('live-check', () => {
  it('without keys: calls nothing, says how to run it, exits 2', async () => {
    mock.reset()
    const r = await run({ LIVE_CHECK_MOCK_BASE: mock.url })
    expect(r.code).toBe(2)
    expect(r.out).toContain('no API keys in the environment')
    expect(mock.recorder.all()).toHaveLength(0)
  })

  it('refuses a non-loopback mock base', async () => {
    const r = await run({ LIVE_CHECK_MOCK_BASE: 'https://example.com', VOYAGE_API_KEY: 'pa-test' })
    expect(r.code).toBe(2)
  })

  it('with keys: every provider checked, a report, keys never printed @R12 @R19', async () => {
    mock.reset()
    // A thinking turn that calls the tool, then the answers (the mock checks the replayed signatures).
    mock.llm.script(
      { reasoning: 'The user wants the time in Tokyo; call the tool.', toolCalls: [{ name: 'get_local_time', input: { city: 'Tokyo' } }], match: { api: 'anthropic' } },
      { reasoning: 'Report the time.', text: 'It is 21:04 in Tokyo.', match: { api: 'anthropic' } },
      { reasoning: 'Evening.', text: 'Evening.', match: { api: 'anthropic' } }
    )
    const keys = {
      ANTHROPIC_API_KEY: 'sk-ant-secret-0123456789',
      ANTHROPIC_MODEL: 'claude-mock-5',
      ELEVENLABS_API_KEY: 'xi-secret-0123456789',
      VOYAGE_API_KEY: 'pa-secret-0123456789',
      OPENAI_API_KEY: 'sk-secret-0123456789',
      DEEPGRAM_API_KEY: 'dg-secret-0123456789'
    }
    const r = await run({ LIVE_CHECK_MOCK_BASE: mock.url, ...keys })
    console.log(r.out)
    for (const v of Object.values(keys)) if (v.includes('secret')) expect(r.out).not.toContain(v)
    expect(r.out).toMatch(/PASS\s+ElevenLabs \/with-timestamps alignment/)
    expect(r.out).toMatch(/PASS\s+Voyage embeddings/)
    expect(r.out).toMatch(/PASS\s+Anthropic replay of thinking \+ tool call/)
    expect(r.out).toMatch(/PASS\s+Anthropic long-history replay/)
    expect(r.out).toMatch(/PASS\s+OpenAI \/models/)
    expect(r.out).toMatch(/OpenAI transcription/)
    expect(r.out).toMatch(/Summary: \d+ passed/)
    expect(r.code).toBe(0)
  }, 60_000)
})
