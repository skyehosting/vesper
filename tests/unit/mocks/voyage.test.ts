import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startMockServer, type MockServer } from '../../mocks/server'
import { cosine, mockEmbedding, quantize } from '../../mocks/voyage'

let mock: MockServer
beforeAll(async () => {
  mock = await startMockServer()
})
afterAll(async () => {
  await mock.close()
})
beforeEach(() => mock.reset())

function post(path: string, body: unknown, key: string | null = 'pa-test'): Promise<Response> {
  return fetch(`${mock.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) })
}

describe('mock Voyage embeddings', () => {
  it('is deterministic and puts texts that share words closer together', () => {
    const a = mockEmbedding('We planned a trip to Lisbon in spring')
    expect(Array.from(mockEmbedding('We planned a trip to Lisbon in spring'))).toEqual(Array.from(a))
    const near = cosine(a, mockEmbedding('the Lisbon trip in spring'))
    const far = cosine(a, mockEmbedding('my sourdough starter died again'))
    expect(near).toBeGreaterThan(0.6)
    expect(Math.abs(far)).toBeLessThan(0.3)
    expect(near).toBeGreaterThan(far + 0.4)
  })

  it('honours output_dimension (Matryoshka prefix), output_dtype and base64', async () => {
    const res = await post('/v1/embeddings', { input: ['hello world', 'second'], model: 'voyage-4-lite', input_type: 'document', output_dimension: 256, output_dtype: 'int8' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ embedding: number[]; index: number }>; usage: { total_tokens: number }; model: string }
    expect(body.data).toHaveLength(2)
    expect(body.data[0].embedding).toHaveLength(256)
    expect(body.data[0].embedding.every((v) => Number.isInteger(v) && v >= -128 && v <= 127)).toBe(true)
    expect(body.usage.total_tokens).toBeGreaterThan(0)
    const b64 = (await (await post('/v1/embeddings', { input: 'hello world', model: 'voyage-4-lite', output_dimension: 256, output_dtype: 'int8', encoding_format: 'base64' })).json()) as { data: Array<{ embedding: string }> }
    const buf = Buffer.from(b64.data[0].embedding, 'base64')
    expect(Array.from(new Int8Array(buf.buffer, buf.byteOffset, buf.length))).toEqual(body.data[0].embedding)
    const bin = (await (await post('/v1/embeddings', { input: 'hello world', model: 'voyage-4-lite', output_dimension: 1024, output_dtype: 'ubinary' })).json()) as { data: Array<{ embedding: number[] }> }
    expect(bin.data[0].embedding).toHaveLength(128)
    // The first 256 dims of the 1024-d vector carry the same signs as the 256-d one (prefix property).
    const full = quantize(mockEmbedding('hello world', 1024), 'float').slice(0, 256)
    const small = quantize(mockEmbedding('hello world', 256), 'float')
    expect(full.map(Math.sign)).toEqual(small.map(Math.sign))
  })

  it('validates the body before the key, then rejects missing or wrong keys', async () => {
    expect((await post('/v1/embeddings', { input: [], model: 'voyage-4-lite' }, null)).status).toBe(400)
    const noKey = await post('/v1/embeddings', { input: 'x', model: 'voyage-4-lite' }, null)
    expect(noKey.status).toBe(401)
    expect(await noKey.json()).toEqual({ detail: 'Unauthorized' })
    mock.voyage.setKeys(['pa-good'])
    expect((await post('/v1/embeddings', { input: 'x', model: 'voyage-4-lite' }, 'pa-bad')).status).toBe(401)
    expect((await post('/v1/embeddings', { input: 'x', model: 'voyage-4-lite' }, 'pa-good')).status).toBe(200)
    expect((await post('/v1/embeddings', { input: Array(1001).fill('x'), model: 'voyage-4-lite' }, 'pa-good')).status).toBe(400)
  })

  it('free-trial mode allows 3 requests a minute, then 429; failNext injects transient errors', async () => {
    mock.voyage.mode('free-trial')
    for (let i = 0; i < 3; i++) expect((await post('/v1/embeddings', { input: `t${i}`, model: 'voyage-4-lite' })).status).toBe(200)
    expect((await post('/v1/embeddings', { input: 't4', model: 'voyage-4-lite' })).status).toBe(429)
    mock.voyage.mode('ok')
    mock.voyage.failNext(503)
    expect((await post('/v1/embeddings', { input: 'a', model: 'voyage-4-lite' })).status).toBe(503)
    expect((await post('/v1/embeddings', { input: 'a', model: 'voyage-4-lite' })).status).toBe(200)
    expect(mock.voyage.embeddedTexts()).toEqual(['t0', 't1', 't2', 'a'])
  })
})

describe('mock Voyage rerank', () => {
  it('orders documents by query-word overlap and honours top_k', async () => {
    const docs = ['I baked bread today', 'Our Lisbon trip was in spring', 'Lisbon has great tram rides', 'nothing related']
    const res = await post('/v1/rerank', { query: 'when was the Lisbon trip', documents: docs, model: 'rerank-3-lite', top_k: 2, return_documents: true })
    const body = (await res.json()) as { data: Array<{ index: number; relevance_score: number; document: string }> }
    expect(body.data.map((d) => d.index)).toEqual([1, 2])
    expect(body.data[0].relevance_score).toBeGreaterThan(body.data[1].relevance_score)
    expect(body.data[0].document).toBe(docs[1])
    expect(mock.voyage.rerankQueries()).toEqual(['when was the Lisbon trip'])
  })
})
