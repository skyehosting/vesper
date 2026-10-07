/**
 * Phase 4c UX polish regressions (fix-ux): the memory timeline's plain-text previews (F53) and first-run copy (F56).
 * The layout findings (F46 rows, F47 first-run clipping, F50 focus, F52 entries, F55 banners, F57 offline banner) are
 * covered end to end in tests/e2e/browser/ux-polish.spec.ts. @R7 @R22
 */
import { describe, expect, it } from 'vitest'
import { ianaZone } from '@shared/time'
import { manifestMeta } from '../../../src/web/features/memory/manifest.logic'
import { previewText } from '../../../src/web/features/memory/timeline.logic'

describe('memory timeline previews (F53)', () => {
  const reply = [
    "Here's how the **history window** keeps a million messages _smooth_:",
    '',
    '## The idea',
    '',
    '1. Only about three pages stay loaded (`3 × N` rows).',
    '2. See [the notes](https://example.com/notes) for more.',
    '',
    '```ts',
    'const keep = 3 * pageSize',
    '```',
    '',
    '> quoted ~~old~~ text'
  ].join('\n')

  it('an AI reply shows its words, not its markdown', () => {
    const { text } = previewText(reply, 4000, 'assistant')
    expect(text).not.toMatch(/\*\*|__|##|`|\]\(|~~|^>/m)
    expect(text).toContain("Here's how the history window keeps a million messages smooth:")
    expect(text).toContain('The idea')
    expect(text).toContain('1. Only about three pages stay loaded (3 × N rows).')
    expect(text).toContain('See the notes for more.')
    expect(text).toContain('const keep = 3 * pageSize')
    expect(text).toContain('quoted old text')
  })

  it("the owner's own message stays exactly as typed (it is shown as plain text in chat too)", () => {
    expect(previewText('I *really* mean **this** `x`', 4000, 'user').text).toBe('I *really* mean **this** `x`')
    expect(previewText('a\r\n\n\n\nb').text).toBe('a\n\nb')
  })

  it('keeps angle-bracket words the chat shows as text (raw HTML is never dropped)', () => {
    const body = 'Use List<String> here, or wrap it in <Suspense> first. Returns Promise<void>.'
    expect(previewText(body, 4000, 'assistant').text).toBe(body)
    expect(previewText('a <b>bold</b> c', 4000, 'assistant').text).toBe('a <b>bold</b> c')
    const block = ['<details>', '<summary>More</summary>', '</details>'].join('\n')
    expect(previewText(block, 4000, 'assistant').text).toBe(block)
  })

  it('an image-only reply previews as the image, never as an empty "attachments only" entry', () => {
    expect(previewText('![diagram](https://x.y/a.png)', 4000, 'assistant').text).toBe('[image: diagram]')
    expect(previewText('![](https://x.y/a.png)', 4000, 'assistant').text).toBe('[image]')
    expect(previewText(['See ![chart][c]', '', '[c]: https://x.y/c.png'].join('\n'), 4000, 'assistant').text).toBe('See [image: chart]')
  })

  it('a tight list stays one item per line, with task boxes and nesting', () => {
    expect(previewText(['- [ ] todo', '- [x] done'].join('\n'), 4000, 'assistant').text).toBe(['☐ todo', '☑ done'].join('\n'))
    expect(previewText(['1. one', '   - a', '   - b', '2. two'].join('\n'), 4000, 'assistant').text).toBe(['1. one', '  • a', '  • b', '2. two'].join('\n'))
  })

  it('still clamps long replies after stripping', () => {
    expect(previewText('**' + 'x'.repeat(10) + '**', 4, 'assistant')).toEqual({ text: 'xxxx…', cut: true })
  })
})

describe('manifest card meta line (F56)', () => {
  const zone = ianaZone('Europe/Lisbon')
  const NOW = Date.UTC(2026, 9, 5, 12, 0)
  const created = Date.UTC(2026, 9, 5, 9, 0)

  it('an empty chat says "no messages yet" once, without "last active" or "0 messages"', () => {
    const line = manifestMeta({ createdUtc: created, lastMessageUtc: null, messageCount: 0 }, NOW, zone)
    expect(line).toBe('Created Mon 5 Oct 2026 · no messages yet')
    expect(line).not.toMatch(/last active no|0 messages/)
  })

  it('a chat with messages keeps last active and the count', () => {
    expect(manifestMeta({ createdUtc: created, lastMessageUtc: NOW - 3_600_000, messageCount: 1 }, NOW, zone)).toMatch(/^Created Mon 5 Oct 2026 · last active .+ · 1 message$/)
    expect(manifestMeta({ createdUtc: created, lastMessageUtc: null, messageCount: 4 }, NOW, zone)).toBe('Created Mon 5 Oct 2026 · 4 messages')
  })
})
