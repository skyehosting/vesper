/**
 * readZip memory bound (F02): the inflated-size caps must apply before a high-ratio entry is inflated in one piece.
 * fflate inflates everything pushed in one call, so the archive is fed in small slices (ZIP_PUSH_SLICE) and one
 * push can produce at most ~1032 × slice bytes (deflate's maximum ratio) before the caps are checked.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { readZip, ZIP_PUSH_SLICE } from '@server/data/zipio'

const MiB = 1024 * 1024
const NAME = `attachments/${'a'.repeat(64)}`
/** Largest inflated output one push may produce: deflate tops out near 1032:1, plus fflate's 32 KiB window. */
const PUSH_BOUND = 1032 * ZIP_PUSH_SLICE + 64 * 1024

let dir: string
let bomb: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-zipio-'))
  bomb = path.join(dir, 'bomb.zip')
  // 32 MiB of zeros packs into ~32 KB: one read chunk, so before the fix it was inflated in ONE piece (> PUSH_BOUND).
  fs.writeFileSync(bomb, zipSync({ [NAME]: [new Uint8Array(32 * MiB), { level: 9 }] }))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('readZip (F02)', () => {
  it('inflates a high-ratio entry in bounded pieces', async () => {
    expect(fs.statSync(bomb).size).toBeLessThan(MiB)
    let biggest = 0
    let got = 0
    await readZip(bomb, {
      open: () => ({
        data: (c) => {
          biggest = Math.max(biggest, c.length)
          got += c.length
        },
        end: () => undefined
      }),
      maxEntryBytes: () => 128 * MiB,
      maxTotalBytes: 128 * MiB
    })
    expect(got).toBe(32 * MiB)
    expect(biggest).toBeLessThanOrEqual(PUSH_BOUND)
  })

  it('stops at the cap: payload_too_large, and the sink never gets more than the cap', async () => {
    let got = 0
    const cap = 5 * MiB
    await expect(
      readZip(bomb, {
        open: () => ({ data: (c) => void (got += c.length), end: () => undefined }),
        maxEntryBytes: () => cap,
        maxTotalBytes: 2048 * MiB
      })
    ).rejects.toMatchObject({ info: { code: 'payload_too_large' } })

    expect(got).toBeLessThanOrEqual(cap)
  })

  it('still reads normal archives exactly', async () => {
    const file = path.join(dir, 'ok.zip')
    const text = 'hello '.repeat(100_000)
    fs.writeFileSync(file, zipSync({ 'vesper-export.json': new TextEncoder().encode(text), 'skip.txt': new Uint8Array(10) }))
    const parts: Uint8Array[] = []
    let ended = false
    await readZip(file, {
      open: (n) => (n === 'vesper-export.json' ? { data: (c) => void parts.push(c.slice()), end: () => void (ended = true) } : null),
      maxEntryBytes: () => MiB,
      maxTotalBytes: MiB
    })
    expect(ended).toBe(true)
    expect(Buffer.concat(parts).toString('utf8')).toBe(text)
  })
})
