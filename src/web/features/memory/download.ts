/**
 * Save small generated files (manifest.json) with an object URL that is revoked right after the click, and trigger
 * server downloads (exports) with a plain same-origin link (the desktop shows its Save As dialog, 07 B11 main
 * `will-download`). `blobUrlsLive()` is checked by the leak test.
 */
let live = 0

export function blobUrlsLive(): number {
  return live
}

function clickLink(href: string, fileName?: string): void {
  const a = document.createElement('a')
  a.href = href
  if (fileName !== undefined) a.download = fileName
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function saveText(fileName: string, text: string, mime = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  live++
  try {
    clickLink(url, fileName)
  } finally {
    // The download has its own reference once started; revoke on the next task.
    window.setTimeout(() => {
      URL.revokeObjectURL(url)
      live--
    }, 0)
  }
}

/** Start a download of a same-origin URL (the server sets Content-Disposition). */
export function downloadUrl(href: string): void {
  clickLink(href, '')
}
