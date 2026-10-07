/**
 * F69 (R21, 07 B13/B18, C18): titles, summaries and recaps of a chat that runs on a model on this PC never go to a cloud
 * utility profile — they run on the chat's own (local) profile. Cloud chats keep using the utility profile.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LlmProfile } from '@shared/settings'
import { ChatHarness, chatRequests, waitMsg } from './harness'
import { startMockServer, type MockServer } from '../../mocks/server'

let mock: MockServer
let h: ChatHarness
const CLOUD_KEY = 'sk-test-cloudkey-123456'

const cloud = { id: 'cloud', label: 'Cloud', preset: 'custom', adapter: 'openai', baseUrl: 'https://api.example-cloud.com/openai/v1', model: 'mock-echo' } as LlmProfile
const local = { id: 'local', label: 'Ollama', preset: 'ollama', adapter: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'mock-local' } as LlmProfile

beforeAll(async () => {
  mock = await startMockServer()
  process.env.VESPER_MOCK_BASE = mock.url
  h = await ChatHarness.start({ mock })
})
afterAll(async () => {
  await h.close()
  await mock.close()
  delete process.env.VESPER_MOCK_BASE
})
beforeEach(async () => {
  mock.reset()
  await h.ctx.settings.patch({ chat: { autoTitle: true }, llm: { profiles: [cloud, local], defaultProfile: 'cloud', utilityProfile: null, utilityModel: '' } })
  await h.ctx.secrets.set('llm:cloud', CLOUD_KEY, cloud.baseUrl)
})

/** Requests that went to the cloud profile (the mock strips the /openai prefix; the cloud key and model tell them apart). */
const toCloud = (): ReturnType<typeof chatRequests> => chatRequests(mock).filter((r) => JSON.stringify(r.headers).includes(CLOUD_KEY) || r.json.model === 'mock-echo')
const sentText = (r: ReturnType<typeof chatRequests>[number]): string => JSON.stringify(r.json)

describe('utility tasks follow a local chat (F69)', () => {
  it('the auto-title of a chat on a local model runs on that local model, never on the cloud default', async () => {
    const s = await h.session()
    await h.patchSession(s.uid, { llmProfile: 'local' })
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'my private diary entry about my medical results')
    await waitMsg(p, (m) => m.t === 'session.updated' && !!m.session.title)
    const titleReq = chatRequests(mock).find((r) => sentText(r).includes('You name conversations'))!
    expect(titleReq.json.model).toBe('mock-local')
    expect(toCloud()).toEqual([])
    expect(JSON.stringify(chatRequests(mock).map((r) => r.headers))).not.toContain(CLOUD_KEY)
  })

  it('an explicit cloud utility profile is not used for a local chat either (the /continue recap too)', async () => {
    await h.ctx.settings.patch({ llm: { utilityProfile: 'cloud' } })
    const s = await h.session()
    await h.patchSession(s.uid, { llmProfile: 'local' })
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'secret plans for the weekend')
    await waitMsg(p, (m) => m.t === 'session.updated' && !!m.session.title)
    await h.engine.recap(s.uid)
    expect(chatRequests(mock).some((r) => sentText(r).includes('You write recaps'))).toBe(true)
    expect(toCloud()).toEqual([])
  })

  it('a cloud chat keeps using the utility profile', async () => {
    await h.ctx.settings.patch({ llm: { utilityProfile: 'cloud', defaultProfile: 'local' } })
    const s = await h.session()
    await h.patchSession(s.uid, { llmProfile: 'cloud' })
    const p = await h.client(s.uid)
    await h.send(p, s.uid, 'what a nice day')
    await waitMsg(p, (m) => m.t === 'session.updated' && !!m.session.title)
    const titleReq = chatRequests(mock).find((r) => sentText(r).includes('You name conversations'))!
    expect(titleReq.json.model).toBe('mock-echo')
    expect(JSON.stringify(titleReq.headers)).toContain(CLOUD_KEY)
  })
})
