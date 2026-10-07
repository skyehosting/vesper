/** Shared chat-ui e2e fixtures. */

/** A reply exercising every markdown feature the renderer supports (07 D7). */
export const RICH_REPLY = [
  "Here's how the **history window** keeps a million messages smooth:",
  '',
  '## The idea',
  '',
  '1. Only about three pages stay loaded (`3 × N` rows).',
  '2. Older pages load as you scroll up; rows far below unload.',
  '3. The scrubber on the right jumps anywhere in the timeline.',
  '',
  '> Your place is remembered per device, so coming back feels seamless.',
  '',
  '```ts',
  'const cap = pageSize * 3',
  'if (rows.length > cap) unload(rows.length - cap)',
  '```',
  '',
  '| Setting | Default | Range |',
  '|---|---|---|',
  '| Page size | 100 | 20–300 |',
  '| Window | 3 pages | fixed |',
  '',
  '- [x] Anchor kept within 2 px',
  '- [ ] Something still to do',
  '',
  'More in the [design notes](https://example.com/vesper/history) or ask me anything.'
].join('\n')
