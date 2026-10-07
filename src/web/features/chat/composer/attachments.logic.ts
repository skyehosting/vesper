/**
 * Attachment rules for the composer (R18, 07 B6/C8): what can be attached, how images are scaled before upload
 * (long edge ≤ 1568 px, ≤ 3.75 MB, JPEG q85 or PNG when the image has transparency) plus a 320 px thumbnail, and the
 * "Pasted text" chip for long pastes. Pure; the canvas work is in prepare.ts.
 */

export const MAX_FILES = 10
export const IMAGE_LONG_EDGE = 1568
export const IMAGE_MAX_BYTES = 3.75 * 1024 * 1024
export const THUMB_EDGE = 320
/** Pastes longer than this become a "Pasted text" attachment (07 C8). */
export const PASTE_CHIP_CHARS = 4000

const CODE_EXT = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'html', 'css', 'scss', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'log', 'sh', 'ps1', 'bat', 'sql', 'lua', 'r', 'vue', 'svelte']
export const ACCEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'application/pdf', '.pdf', '.docx', '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', ...CODE_EXT.map((e) => `.${e}`)].join(',')

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

export type AttachmentKind = 'image' | 'pdf' | 'docx' | 'text' | 'other'

export function kindOf(name: string, type: string): AttachmentKind {
  const t = type.toLowerCase()
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (IMAGE_TYPES.has(t)) return 'image'
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (ext === 'docx') return 'docx'
  if (t.startsWith('text/') || ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', ...CODE_EXT].includes(ext)) return 'text'
  return 'other'
}

/** Target size for an image: scale so the long edge is ≤ `edge` (never upscale). */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number; scale: number } {
  const long = Math.max(width, height)
  const scale = long > edge ? edge / long : 1
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale }
}

/** Whether the original bytes can be uploaded unchanged (already small enough, a format every provider takes). */
export function keepOriginal(type: string, size: number, width: number, height: number): boolean {
  return (type === 'image/jpeg' || type === 'image/png' || type === 'image/gif' || type === 'image/webp') && size <= IMAGE_MAX_BYTES && Math.max(width, height) <= IMAGE_LONG_EDGE
}

/** File name for a re-encoded image ("photo.heic" → "photo.jpg"). */
export function renameFor(name: string, mime: 'image/jpeg' | 'image/png'): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'image'
  return `${base}.${mime === 'image/png' ? 'png' : 'jpg'}`
}

/** Any pixel not fully opaque? (RGBA bytes.) */
export function hasAlpha(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 255) return true
  return false
}

/** One-line label for a pasted-text chip. */
export function pastePreview(text: string): string {
  const first = text.trim().split('\n')[0] ?? ''
  return first.length > 60 ? `${first.slice(0, 60)}…` : first
}

/** Name for a pasted file that came without one ("image.png" from a screenshot). */
export function pastedName(type: string, index: number, now = new Date()): string {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`
  const ext = type === 'image/png' ? 'png' : type === 'image/jpeg' ? 'jpg' : type === 'image/gif' ? 'gif' : type === 'image/webp' ? 'webp' : 'bin'
  return `Pasted ${stamp}${index ? ` (${index + 1})` : ''}.${ext}`
}
