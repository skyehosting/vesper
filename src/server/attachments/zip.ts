/**
 * ZIP central-directory reader (no inflating). Used to recognise DOCX files when sniffing and to refuse
 * decompression bombs before mammoth touches them (07 B6: > 50 MB uncompressed or a ratio > 100:1). Sizes come from
 * the central directory; a crafted archive can lie there, which is why the extract process also runs with a heap cap
 * and a timeout.
 */
import type { ByteSource } from './bytes'

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EOCD_SIG = 0x06064b50
const CD_SIG = 0x02014b50
const MAX_CD_BYTES = 16 * 1024 * 1024
const MAX_ENTRIES = 20_000

/** Limits for archives we extract (07 B6). */
export const DOCX_LIMITS = { maxUncompressed: 50 * 1024 * 1024, maxRatio: 100 } as const

function u64(b: Buffer, at: number): number {
  const v = b.readBigUInt64LE(at)
  // Anything past 2^53 is absurd for our limits; clamp so comparisons stay meaningful.
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v)
}

/** The entries of a ZIP archive, or null when `src` is not a readable ZIP (or its directory is unreasonably big). */
export async function readCentralDirectory(src: ByteSource): Promise<ZipEntry[] | null> {
  if (src.size < 22) return null
  const tailLen = Math.min(src.size, 22 + 0xffff)
  const tail = await src.read(src.size - tailLen, tailLen)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
  let count = tail.readUInt16LE(eocd + 10)
  let cdSize = tail.readUInt32LE(eocd + 12)
  let cdOffset = tail.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the locator sits right before the EOCD record.
    const locAt = src.size - tailLen + eocd - 20
    if (locAt < 0) return null
    const loc = await src.read(locAt, 20)
    if (loc.length < 20 || loc.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) return null
    const recAt = u64(loc, 8)
    const rec = await src.read(recAt, 56)
    if (rec.length < 56 || rec.readUInt32LE(0) !== ZIP64_EOCD_SIG) return null
    count = u64(rec, 32)
    cdSize = u64(rec, 40)
    cdOffset = u64(rec, 48)
  }
  if (count > MAX_ENTRIES || cdSize > MAX_CD_BYTES || cdOffset + cdSize > src.size) return null
  const cd = await src.read(cdOffset, cdSize)
  const entries: ZipEntry[] = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CD_SIG) return null
    const method = cd.readUInt16LE(p + 10)
    let compressedSize = cd.readUInt32LE(p + 20)
    let uncompressedSize = cd.readUInt32LE(p + 24)
    const nameLen = cd.readUInt16LE(p + 28)
    const extraLen = cd.readUInt16LE(p + 30)
    const commentLen = cd.readUInt16LE(p + 32)
    let localHeaderOffset = cd.readUInt32LE(p + 42)
    if (p + 46 + nameLen + extraLen > cd.length) return null
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
    // ZIP64 extended sizes live in extra field 0x0001, in this order, only for the fields that are 0xFFFFFFFF.
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const tag = cd.readUInt16LE(e)
      const len = cd.readUInt16LE(e + 2)
      if (tag === 0x0001) {
        let q = e + 4
        const end = Math.min(e + 4 + len, extraEnd)
        if (uncompressedSize === 0xffffffff && q + 8 <= end) {
          uncompressedSize = u64(cd, q)
          q += 8
        }
        if (compressedSize === 0xffffffff && q + 8 <= end) {
          compressedSize = u64(cd, q)
          q += 8
        }
        if (localHeaderOffset === 0xffffffff && q + 8 <= end) localHeaderOffset = u64(cd, q)
      }
      e += 4 + len
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** A Word document: [Content_Types].xml plus the main part (the shape mammoth needs). */
export function isDocx(entries: readonly ZipEntry[]): boolean {
  const names = new Set(entries.map((e) => e.name))
  return names.has('[Content_Types].xml') && names.has('word/document.xml')
}

/** Why an archive must not be inflated, or null when it is within the limits. */
export function archiveProblem(entries: readonly ZipEntry[], limits: { maxUncompressed: number; maxRatio: number } = DOCX_LIMITS): 'too_large' | 'ratio' | null {
  let total = 0
  let compressed = 0
  for (const e of entries) {
    total += e.uncompressedSize
    compressed += e.compressedSize
    if (total > limits.maxUncompressed) return 'too_large'
  }
  if (total > 0 && total / Math.max(1, compressed) > limits.maxRatio) return 'ratio'
  return null
}
