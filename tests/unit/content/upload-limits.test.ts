/**
 * Request-size cap of receiveUpload (F03, 07 B6): attachments keep "request ≤ 110 MB", but the import route's
 * 200 MB file cap must be reachable — the declared Content-Length check used to reject anything above 110 MiB.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import type { FastifyRequest } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_REQUEST_BYTES, receiveUpload } from '@server/attachments/upload'
import { IMPORT_LIMITS } from '@server/data/import'

const MiB = 1024 * 1024
let dir: string
let n = 0

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vesper-upload-'))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

/** A multipart request that declares `declared` bytes and carries one small file part. */
function fakeReq(declared: number): { req: FastifyRequest; partsCalled: () => boolean } {
  let called = false
  const req = {
    headers: { 'content-length': String(declared) },
    isMultipart: () => true,
    parts: () => {
      called = true
      return (async function* () {
        yield { type: 'file', fieldname: 'file', filename: 'export.zip', mimetype: 'application/zip', file: Readable.from([Buffer.from('PK\u0003\u0004')]) }
      })()
    }
  } as unknown as FastifyRequest
  return { req, partsCalled: () => called }
}

const tempPath = () => path.join(dir, `t${n++}`)
const importOpts = { tempPath, maxFileBytes: IMPORT_LIMITS.maxUploadBytes, maxThumbBytes: 0 }
const attachmentOpts = { tempPath, maxFileBytes: 25 * MiB, maxThumbBytes: 2 * MiB }

describe('receiveUpload request cap (F03)', () => {
  it('an import up to the documented 200 MB is not refused by the attachment request cap', async () => {
    for (const declared of [150 * MiB, IMPORT_LIMITS.maxUploadBytes + 64 * 1024]) {
      const { req, partsCalled } = fakeReq(declared)
      const up = await receiveUpload(req, importOpts)
      expect(partsCalled()).toBe(true)
      expect(up.file.size).toBe(4)
    }
  })

  it('an import declaring more than 200 MB plus multipart overhead is refused before reading', async () => {
    const { req, partsCalled } = fakeReq(IMPORT_LIMITS.maxUploadBytes + 2 * MiB)
    await expect(receiveUpload(req, importOpts)).rejects.toMatchObject({ status: 413 })
    expect(partsCalled()).toBe(false)
  })

  it('attachments keep the 110 MB request cap', async () => {
    const ok = fakeReq(MAX_REQUEST_BYTES)
    await receiveUpload(ok.req, attachmentOpts)
    const big = fakeReq(150 * MiB)
    await expect(receiveUpload(big.req, attachmentOpts)).rejects.toMatchObject({ status: 413 })
    expect(big.partsCalled()).toBe(false)
  })
})
