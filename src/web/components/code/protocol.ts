/** Messages between the page and highlight.worker.ts. */

/** One token: text, dark-theme color, light-theme color, font style bits (1 italic, 2 bold, 4 underline). */
export interface HlToken {
  t: string
  d?: string
  l?: string
  s?: number
}

export type HlLines = HlToken[][]

export interface HlRequest {
  id: number
  code: string
  lang: string
}

export type HlResponse = { id: number; lines: HlLines; error?: undefined } | { id: number; error: string; lines?: undefined }
