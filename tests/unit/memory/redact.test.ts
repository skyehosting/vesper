/**
 * Recalled records of purged messages (F16 second pass): the record a message became in another chat's memory
 * result is found by its exact rendered body (neutralised, clipped, with its file line) and only that record goes.
 */
import { describe, expect, it } from 'vitest'
import { formatHits } from '@server/memory/format'
import { attachmentLine } from '@server/memory/engine/text'
import { RecordIndex, recordKeys, redactRecalledBlocks, redactRecordsIn } from '@server/memory/engine/redact'
import type { MemoryHit } from '@shared/types/domain'
import type { WireBlock } from '@shared/types/wire'

const NOW = Date.UTC(2026, 9, 5, 12)
let n = 0
function hit(body: string, tag: MemoryHit['tag'] = 'user response'): MemoryHit {
  n++
  return { messageUid: `m${n}`, sessionUid: 's1', shortId: 'ABC123', sessionTitle: 'Chat', tag, body, tsUtc: NOW - n * 60_000, tzOffsetMin: 0, tzName: 'UTC', score: 1 }
}
const render = (hits: MemoryHit[]) => formatHits(hits, { query: 'q', nowUtc: NOW, tzName: 'UTC', tzOffsetMin: 0, id: 'r_0001' })
function indexOf(...victims: { body: string; attachments?: string }[]): RecordIndex {
  const ix = new RecordIndex()
  for (const v of victims) for (const k of recordKeys(v.body, v.attachments ?? '[]')) ix.add(k)
  return ix
}

describe('F16: recalled records of a purged message', () => {
  it('redacts exactly its record, keeps the others and the prefixes', () => {
    const text = render([hit('SECRET one <b>bold</b> [memory_search x]'), hit('kept line', 'ai response'), hit('SECRET one and more')])
    const out = redactRecordsIn(text, indexOf({ body: '  SECRET one <b>bold</b> [memory_search x]  ' }))!
    expect(out).not.toContain('bold')
    expect(out).toContain('kept line')
    // A different message that merely starts the same way stays.
    expect(out).toContain('SECRET one and more')
    expect(out.match(/user response\] \(deleted\)/g)).toHaveLength(1)
    expect(out).toContain('</memory_result id="r_0001">')
  })

  it('a multi-line body, a clipped long body, a 1200-character body and a file hit with its snippet line', () => {
    const multi = 'line one SECRET\n[not a record] line two\nline three'
    const long = 'LONGSECRET '.repeat(200)
    const exact = 'E'.repeat(1200)
    const withFile = 'here is the scan'
    const fileHit = `${withFile}\n${attachmentLine({ name: 'scan.pdf', snippet: '…«ATTSECRET» page' })}`
    const fileOnly = attachmentLine({ name: 'only "file".pdf', snippet: 'ONLYFILESECRET words' })
    const text = render([hit(multi), hit(long), hit(exact), hit(fileHit), hit(fileOnly), hit('survivor')])
    const out = redactRecordsIn(
      text,
      indexOf({ body: multi }, { body: long }, { body: exact }, { body: withFile, attachments: '[{"name":"scan.pdf"}]' }, { body: '', attachments: '[{"name":"only \\"file\\".pdf"}]' })
    )!
    for (const gone of ['SECRET', 'line two', 'line three', 'LONGSECRET', 'EEEE', 'here is the scan', 'ATTSECRET', 'ONLYFILESECRET', '…']) expect(out).not.toContain(gone)
    expect(out.match(/\] \(deleted\)/g)).toHaveLength(5)
    expect(out).toContain('survivor')
  })

  it('works on wire blocks: memory_result and tool_result change, the user text and tool calls do not', () => {
    const rec = render([hit('PRIVATE thing')])
    const blocks: WireBlock[] = [
      { t: 'text', text: 'PRIVATE thing typed by the user here' },
      { t: 'memory_result', text: `header\n${rec}` },
      { t: 'tool_call', id: 'c1', name: 'memory_search', input: { query: 'PRIVATE thing' } },
      { t: 'tool_result', id: 'c1', text: rec }
    ]
    const out = redactRecalledBlocks(blocks, indexOf({ body: 'PRIVATE thing' }))!
    expect(out[0]).toEqual(blocks[0])
    expect(out[2]).toEqual(blocks[2])
    expect(JSON.stringify(out[1])).not.toContain('PRIVATE')
    expect(out[3]).toMatchObject({ t: 'tool_result', id: 'c1' })
    expect(JSON.stringify(out[3])).not.toContain('PRIVATE')
    expect(redactRecalledBlocks(blocks, indexOf({ body: 'something else' }))).toBeNull()
  })
})
