/**
 * The composer's pending attachments (R18, 07 B6): each file is checked, images are prepared in the client, and the
 * upload starts at once with progress; removing a file aborts its upload. Every object URL and in-flight upload is
 * owned here and released on remove, send and unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentRef } from '@shared/types/domain'
import { partitionFiles, rejectMessage, type Rejected } from '../../../components/internal/files.logic'
import { toast } from '../../../components/Toast'
import { api, uploadAttachment } from '../../../lib/api'
import { toApiError } from '../../../lib/errors.logic'
import { ACCEPT, kindOf, MAX_FILES, pastedName, type AttachmentKind } from './attachments.logic'
import { prepareImage } from './prepare'

export interface Pending {
  id: string
  name: string
  kind: AttachmentKind
  size: number
  /** Object URL of the thumbnail (images). */
  preview: string | null
  /** For "Pasted text" chips: the first line. */
  pasted?: string
  status: 'preparing' | 'uploading' | 'done' | 'error'
  progress: number
  ref: AttachmentRef | null
  error: string | null
}

let objectUrls = 0
/** Live object URLs created by composers (leak checks). */
export function attachmentUrlCount(): number {
  return objectUrls
}

let seq = 0

/**
 * `temporary`: the chat is temporary (uploads go to the temp store, never vesper.db — 07 B9); null while the chat's
 * kind is not known yet, in which case an upload asks the server first rather than guessing "permanent" (F70).
 */
export function useAttachments(o: { maxBytes: number; temporary: boolean | null; sessionUid: string }) {
  const [items, setItems] = useState<Pending[]>([])
  const aborts = useRef(new Map<string, AbortController>())
  const urls = useRef(new Map<string, string>())
  const count = useRef(0)
  count.current = items.length
  const opts = useRef(o)
  opts.current = o

  const release = useCallback((id: string) => {
    aborts.current.get(id)?.abort()
    aborts.current.delete(id)
    const u = urls.current.get(id)
    if (u) {
      URL.revokeObjectURL(u)
      urls.current.delete(id)
      objectUrls--
    }
  }, [])

  useEffect(
    () => () => {
      for (const id of [...aborts.current.keys(), ...urls.current.keys()]) release(id)
    },
    [release]
  )

  const patch = (id: string, p: Partial<Pending>): void => setItems((cur) => cur.map((x) => (x.id === id ? { ...x, ...p } : x)))

  const start = useCallback(async (id: string, file: File, kind: AttachmentKind) => {
    const ctrl = new AbortController()
    aborts.current.set(id, ctrl)
    try {
      let blob: Blob = file
      let name = file.name
      let thumb: Blob | undefined
      let meta: { width?: number; height?: number } | undefined
      if (kind === 'image') {
        const p = await prepareImage(file)
        if (ctrl.signal.aborted) return
        blob = p.blob
        name = p.name
        thumb = p.thumb ?? undefined
        meta = { width: p.width, height: p.height }
        if (p.thumb) {
          const u = URL.createObjectURL(p.thumb)
          objectUrls++
          urls.current.set(id, u)
          patch(id, { preview: u, name })
        }
      }
      patch(id, { status: 'uploading', size: blob.size })
      const temporary = opts.current.temporary ?? (await api('GET /api/sessions/:uid', { params: { uid: opts.current.sessionUid }, signal: ctrl.signal })).temporary
      if (ctrl.signal.aborted) return
      const ref = await uploadAttachment(blob, {
        name,
        thumb,
        meta,
        signal: ctrl.signal,
        temporary,
        onProgress: (loaded, total) => patch(id, { progress: total ? loaded / total : 0 })
      })
      patch(id, { status: 'done', progress: 1, ref })
    } catch (e) {
      if (ctrl.signal.aborted) return
      patch(id, { status: 'error', error: toApiError(e).message })
    } finally {
      aborts.current.delete(id)
    }
  }, [])

  /** Add files (button, drop, paste). Returns how many were taken. */
  const add = useCallback(
    (files: readonly File[], pasted?: string): number => {
      const room = MAX_FILES - count.current
      const rules = { accept: ACCEPT, maxBytes: opts.current.maxBytes, maxFiles: Math.max(0, room), rejectEmpty: true }
      const named = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], pastedName(f.type, i), { type: f.type })))
      const { accepted, rejected } = partitionFiles(named, rules)
      report(rejected, rules)
      const fresh: Pending[] = accepted.map((f) => ({
        id: `att${++seq}`,
        name: f.name,
        kind: kindOf(f.name, f.type),
        size: f.size,
        preview: null,
        pasted,
        status: 'preparing',
        progress: 0,
        ref: null,
        error: null
      }))
      if (fresh.length === 0) return 0
      count.current += fresh.length
      setItems((cur) => [...cur, ...fresh])
      fresh.forEach((p, i) => void start(p.id, accepted[i], p.kind))
      return fresh.length
    },
    [start]
  )

  const remove = useCallback(
    (id: string) => {
      release(id)
      setItems((cur) => cur.filter((x) => x.id !== id))
    },
    [release]
  )

  /** Clear after a send (previews are released; the uploaded files stay on the server). */
  const clear = useCallback(() => {
    for (const id of [...urls.current.keys(), ...aborts.current.keys()]) release(id)
    setItems([])
  }, [release])

  /** Put sent attachments back after a failed send (no previews: the files are already uploaded). */
  const restore = useCallback((refs: Pending[]) => setItems((cur) => [...refs.map((r) => ({ ...r, preview: null })), ...cur]), [])

  return { items, add, remove, clear, restore }
}

function report(rejected: Rejected<File>[], rules: { accept?: string; maxBytes?: number; maxFiles?: number }): void {
  if (rejected.length === 0) return
  const msgs = [...new Set(rejected.map((r) => (r.reason === 'count' ? `A message can carry up to ${MAX_FILES} files.` : rejectMessage(r, rules))))]
  toast.warning(msgs.join('\n'), { title: rejected.length === 1 ? "A file wasn't attached" : `${rejected.length} files weren't attached` })
}
