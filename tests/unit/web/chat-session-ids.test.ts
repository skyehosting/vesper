/** Session ids in reply text (07 C18): `#K7Q2MX` → a session chip link; never inside code, links or words. @R8 */
import { describe, expect, it } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { findSessionIds, remarkSessionIds, SESSION_HREF, sessionIdOfHref } from '../../../src/web/features/chat/markdown/sessionIds.logic'

interface Node {
  type: string
  value?: string
  url?: string
  children?: Node[]
}

function links(md: string): string[] {
  const tree = fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as Node
  remarkSessionIds()(tree)
  const out: string[] = []
  const walk = (n: Node): void => {
    if (n.type === 'link' && n.url?.startsWith(SESSION_HREF)) out.push(`${n.url}|${n.children?.map((c) => c.value).join('')}`)
    n.children?.forEach(walk)
  }
  walk(tree)
  return out
}

describe('session ids in replies (07 C18)', () => {
  it('finds display-form ids, not words, hashtags or colours glued to other text', () => {
    expect(findSessionIds('See #K7Q2MX and (#AB12CD).').map((m) => m.shortId)).toEqual(['K7Q2MX', 'AB12CD'])
    expect(findSessionIds('#k7q2mx lower case, #K7Q2MXY too long, a#K7Q2MX glued, #K7Q2M short')).toEqual([])
    // I, L, O, U are not in the alphabet.
    expect(findSessionIds('#KILOUX')).toEqual([])
    expect(findSessionIds('#K7Q2MX.')[0]).toMatchObject({ index: 0, length: 7 })
  })

  it('turns them into links in text, lists and emphasis; never in code, links or headings markers', () => {
    expect(links('We talked about this in #K7Q2MX last week.')).toEqual([`${SESSION_HREF}K7Q2MX|#K7Q2MX`])
    expect(links('- first #AB12CD\n- **bold #ZZ99ZZ**')).toEqual([`${SESSION_HREF}AB12CD|#AB12CD`, `${SESSION_HREF}ZZ99ZZ|#ZZ99ZZ`])
    expect(links('`#K7Q2MX` and\n\n```\n#K7Q2MX\n```')).toEqual([])
    expect(links('[see #K7Q2MX](https://example.com)')).toEqual([])
  })

  it('only well-formed hrefs are session ids', () => {
    expect(sessionIdOfHref(`${SESSION_HREF}K7Q2MX`)).toBe('K7Q2MX')
    expect(sessionIdOfHref(`${SESSION_HREF}K7Q2MX/x`)).toBeNull()
    expect(sessionIdOfHref('/s/K7Q2MX')).toBeNull()
  })
})
