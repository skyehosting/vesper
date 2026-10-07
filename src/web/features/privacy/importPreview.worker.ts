/**
 * Import preview worker: reads the chosen file (JSON, or a ZIP holding conversations.json / vesper-export.json — only
 * that entry is inflated, attachments are skipped), parses it and counts what it holds (importPreview.logic.ts). Runs
 * off the main thread so a 200 MB export never freezes the page; the page terminates it after one answer.
 */
import { unzipSync, strFromU8 } from 'fflate'
import { isDocEntry, previewDoc, type ImportPreview } from './importPreview.logic'

export type PreviewReply = { ok: true; preview: ImportPreview } | { ok: false; message: string }

self.onmessage = async (e: MessageEvent<File | Blob>): Promise<void> => {
  let reply: PreviewReply
  try {
    const bytes = new Uint8Array(await e.data.arrayBuffer())
    let text: string
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      let found: string | null = null
      const files = unzipSync(bytes, {
        filter: (f) => {
          if (!isDocEntry(f.name)) return false
          // A Vesper export wins over a conversations.json in the same archive (server rule).
          if (found === 'vesper-export.json') return false
          found = f.name
          return true
        }
      })
      const entry = files['vesper-export.json'] ?? Object.entries(files).find(([n]) => isDocEntry(n))?.[1]
      if (!entry) throw new Error('That archive has no conversations.json or vesper-export.json.')
      text = strFromU8(entry)
    } else text = new TextDecoder('utf-8').decode(bytes)
    let doc: unknown
    try {
      doc = JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      throw new Error("That file isn't valid JSON.")
    }
    const preview = previewDoc(doc)
    reply = preview ? { ok: true, preview } : { ok: false, message: "That file isn't a ChatGPT, Claude or Vesper export." }
  } catch (err) {
    reply = { ok: false, message: err instanceof Error ? err.message : 'The file could not be read.' }
  }
  ;(self as unknown as Worker).postMessage(reply)
}
