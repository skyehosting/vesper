/**
 * Settings → About → Design notes (07 A1): docs/OWNER-NOTES.md, bundled at build time and rendered as plain markdown
 * (no raw HTML, links only http(s) — 07 B8). Code-split: loads only when the dialog opens.
 */
import type { ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import notes from '../../../../../docs/OWNER-NOTES.md?raw'

function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : ''
}

export default function DesignNotes(): ReactNode {
  return (
    <div className="design-notes">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => {
                if (href && window.vesperDesktop?.openExternal) {
                  e.preventDefault()
                  void window.vesperDesktop.openExternal(href)
                }
              }}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="design-notes__table" tabIndex={0} role="region" aria-label="Table">
              <table>{children}</table>
            </div>
          )
        }}
      >
        {notes}
      </Markdown>
    </div>
  )
}
