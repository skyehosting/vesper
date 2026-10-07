/**
 * Client-side image preparation (07 B6): decode with createImageBitmap, scale on an OffscreenCanvas (long edge ≤ 1568
 * px), encode JPEG q85 — or PNG when the image has transparency — and keep it ≤ 3.75 MB; plus a 320 px thumbnail.
 * Every ImageBitmap is closed; nothing outlives the call.
 */
import { fitWithin, hasAlpha, IMAGE_LONG_EDGE, IMAGE_MAX_BYTES, keepOriginal, renameFor, THUMB_EDGE } from './attachments.logic'

export interface PreparedImage {
  blob: Blob
  name: string
  width: number
  height: number
  thumb: Blob | null
}

function canvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

async function encode(c: OffscreenCanvas | HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality })
  return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality))
}

function draw(src: ImageBitmap, w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  const c = canvas(w, h)
  const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!g) throw new Error('no 2d context')
  g.imageSmoothingQuality = 'high'
  g.drawImage(src, 0, 0, w, h)
  return c
}

/** Transparency check on a small copy (cheap even for big images). */
function transparent(src: ImageBitmap): boolean {
  const s = fitWithin(src.width, src.height, 64)
  const c = draw(src, s.width, s.height)
  const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  return hasAlpha(g.getImageData(0, 0, s.width, s.height).data)
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bmp = await createImageBitmap(file)
  try {
    const { width: w0, height: h0 } = bmp
    const thumbSize = fitWithin(w0, h0, THUMB_EDGE)
    const alpha = file.type !== 'image/jpeg' && transparent(bmp)
    const thumb = await encode(draw(bmp, thumbSize.width, thumbSize.height), alpha ? 'image/png' : 'image/jpeg', 0.8).catch(() => null)
    if (keepOriginal(file.type, file.size, w0, h0)) return { blob: file, name: file.name, width: w0, height: h0, thumb }
    const mime = alpha ? 'image/png' : 'image/jpeg'
    let edge = IMAGE_LONG_EDGE
    let quality = 0.85
    for (let attempt = 0; attempt < 6; attempt++) {
      const s = fitWithin(w0, h0, edge)
      const blob = await encode(draw(bmp, s.width, s.height), mime, mime === 'image/jpeg' ? quality : undefined)
      if (blob.size <= IMAGE_MAX_BYTES || attempt === 5) return { blob, name: renameFor(file.name, mime), width: s.width, height: s.height, thumb }
      // Too big: lower the quality first (JPEG), then the size.
      if (mime === 'image/jpeg' && quality > 0.7) quality -= 0.08
      else edge = Math.round(edge * 0.8)
    }
    throw new Error('unreachable')
  } finally {
    bmp.close()
  }
}
