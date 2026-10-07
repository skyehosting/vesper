import { describe, expect, it } from 'vitest'
import { fenceClosed, hasMath, markdownToPlain, splitBlocks } from '../../../src/web/features/chat/markdown/blocks.logic'
import { isLocalImageSrc, isPrivateHost, linkInfo, remoteImageRisk, urlTransform } from '../../../src/web/features/chat/markdown/links.logic'
import { cutAt } from '../../../src/web/features/chat/messages/cut.logic'

describe('markdown blocks (07 D7)', () => {
  const text = '# Title\n\nFirst paragraph with **bold**.\n\n- one\n- two\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\nx^2\n$$\n'

  it('splits top-level blocks with exact source offsets', () => {
    const blocks = splitBlocks(text)
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'code', 'table', 'math'])
    for (const b of blocks) expect(text.slice(b.start, b.end).trim().length).toBe(b.end - b.start)
    expect(text.slice(blocks[3].start, blocks[3].end)).toBe('```ts\nconst a = 1\n```')
  })

  it('re-parses only the tail while streaming and matches a full parse at every step', () => {
    let cache: { text: string; blocks: ReturnType<typeof splitBlocks> } | null = null
    for (let n = 1; n <= text.length; n += 3) {
      const t = text.slice(0, n)
      const inc = splitBlocks(t, cache)
      cache = { text: t, blocks: inc }
      expect(inc).toEqual(splitBlocks(t))
    }
  })

  it('knows when a code fence is still open', () => {
    expect(fenceClosed('```ts\nconst a')).toBe(false)
    expect(fenceClosed('```ts\nconst a\n```')).toBe(true)
    expect(fenceClosed('````\nx\n```')).toBe(false)
    expect(fenceClosed('    indented')).toBe(true)
    const open = splitBlocks('Hi\n\n```js\nlet x')
    expect(open[open.length - 1]).toMatchObject({ kind: 'code', closed: false })
  })

  it('turns markdown into plain text for "Copy as plain text" (07 C8)', () => {
    expect(markdownToPlain('# Hi\n\nSome **bold** and `code` [link](https://x.y).\n\n1. a\n2. b')).toBe('Hi\n\nSome bold and code link.\n\n1. a\n\n2. b')
    expect(markdownToPlain('')).toBe('')
  })

  it('detects math (single-dollar math is off like the speech segmenter)', () => {
    expect(hasMath('costs $5 and $6')).toBe(false)
    expect(hasMath('$$x$$')).toBe(true)
  })

  it('cuts an interrupted reply at a word boundary (07 C15)', () => {
    expect(cutAt('hello wonderful world', 12)).toBe('hello')
    expect(cutAt('hello', 50)).toBe('hello')
  })
})

describe('link rules (07 B8)', () => {
  const a = { tagName: 'a' }
  const img = { tagName: 'img' }
  it('keeps only http/https/mailto, anchors and in-app links', () => {
    expect(urlTransform('https://example.com/x', 'href', a)).toBe('https://example.com/x')
    expect(urlTransform('mailto:me@x.y', 'href', a)).toBe('mailto:me@x.y')
    expect(urlTransform('/s/abc', 'href', a)).toBe('/s/abc')
    expect(urlTransform('#fn-1', 'href', a)).toBe('#fn-1')
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'vbscript:x', 'data:text/html,<b>x', 'file:///c:/x', '//evil.com/x', 'ms-settings:x'])
      expect(urlTransform(bad, 'href', a)).toBe('')
  })

  it('renders images only from attachments, blob: and data:image', () => {
    const sha = 'ab'.repeat(32)
    expect(urlTransform(`/api/attachments/${sha}`, 'src', img)).toBe(`/api/attachments/${sha}`)
    expect(urlTransform(`/api/attachments/${sha}?thumb=1`, 'src', img)).toBe(`/api/attachments/${sha}?thumb=1`)
    expect(urlTransform('data:image/png;base64,AAA', 'src', img)).toBe('data:image/png;base64,AAA')
    expect(urlTransform('data:image/svg+xml;base64,AAA', 'src', img)).toBe('')
    expect(urlTransform('javascript:x', 'src', img)).toBe('')
    // Remote images keep their URL so the chip can name the host; MdImage never loads them.
    expect(urlTransform('https://tracker.example/p.png', 'src', img)).toBe('https://tracker.example/p.png')
  })

  it('accepts only the exact attachment URL forms: no dot-segments, encodings or other routes (F10)', () => {
    const sha = 'ab'.repeat(32)
    for (const bad of [
      '/api/attachments/../export?format=json',
      '/api/attachments/%2e%2e/auth/log',
      '/api/attachments/%2E%2E/export',
      '/api/attachments/.%2e/export',
      `/api/attachments/${sha}/../../export`,
      `/api/attachments/${sha}/text`,
      `/api/attachments/${sha}?download=1`,
      `/api/attachments/${sha}?thumb=1&x=../`,
      '/api/attachments/..\\export',
      '/api/attachments/abc',
      `/api/attachments/${sha.toUpperCase()}`,
      `/api/attachments/${sha}#x`,
      '/api/attachments/.\n./export',
      '/api/attachments/.\t./export',
    ]) {
      expect(isLocalImageSrc(bad), bad).toBe(false)
      expect(urlTransform(bad, 'src', img), bad).toBe('')
    }
    expect(isLocalImageSrc(`/api/attachments/${sha}`)).toBe(true)
  })

  it('shows the real host when the text names something else, and flags risky links', () => {
    expect(linkInfo('https://www.example.com/a', 'example.com').showHost).toBe(false)
    expect(linkInfo('https://evil.example/a', 'bank.com').showHost).toBe(true)
    expect(linkInfo('https://evil.example/a', 'click here')).toMatchObject({ showHost: true, host: 'evil.example', risky: null })
    expect(linkInfo('http://192.168.1.4/admin', 'router').risky).toMatch(/local network/)
    expect(linkInfo('http://127.0.0.1:41730/api', 'x').risky).toMatch(/local network/)
    expect(linkInfo(`https://x.com/?q=${'a'.repeat(200)}`, 'x').risky).toMatch(/long string/)
    expect(linkInfo('https://xn--pple-43d.com', 'apple').risky).toMatch(/look-alike/)
    expect(linkInfo('', 'x').kind).toBe('invalid')
    expect(linkInfo('/s/abc', 'chat').kind).toBe('app')
  })

  it('compares parsed hosts, never string prefixes or substrings (F11)', () => {
    const shows = (href: string, text: string): boolean => linkInfo(href, text).showHost
    // Prefix and substring look-alikes show the real host.
    expect(shows('https://bank.com.evil.example/login', 'https://bank.com')).toBe(true)
    expect(shows('https://bank.com.evil.example/login', 'bank.com')).toBe(true)
    expect(shows('https://bank.com.evil.example/login', 'Log in at bank.com')).toBe(true)
    expect(shows('https://evil.example/', 'h')).toBe(true)
    expect(shows('https://evil.example/', 'https://')).toBe(true)
    expect(shows('https://notbank.com/', 'bank.com')).toBe(true)
    expect(shows('https://bank.com/', 'notbank.com')).toBe(true)
    // Userinfo in the text names another host than the one it parses to.
    expect(shows('https://evil.example/', 'https://bank.com@evil.example/')).toBe(true)
    // IDN: a Cyrillic "а" in the text is not the ASCII host; the punycode href and its Unicode text agree.
    expect(shows('https://apple.com/', 'аpple.com')).toBe(true)
    expect(shows('https://xn--bcher-kva.de/', 'bücher.de')).toBe(false)
    // Real names of the destination keep the plain text.
    expect(shows('https://example.com/docs/x', 'https://example.com/docs')).toBe(false)
    expect(shows('https://www.example.com/a', 'https://example.com/a')).toBe(false)
    expect(shows('https://example.com/a', 'www.example.com')).toBe(false)
    expect(shows('https://example.com/a', 'Read the guide on Example.com.')).toBe(false)
    expect(shows('https://example.com:8443/a', 'example.com')).toBe(false)
    expect(shows('http://nas/', 'nas')).toBe(false)
    expect(shows('https://example.com/a', '(see “example.com”).')).toBe(false)
  })

  it('asks first when data rides in the path, fragment or a long host label; remote images get the same check (F13)', () => {
    expect(linkInfo(`https://evil.example/${'a'.repeat(300)}`, 'x').risky).toMatch(/long string/)
    expect(linkInfo(`https://evil.example/#${'a'.repeat(200)}`, 'x').risky).toMatch(/long string/)
    expect(linkInfo(`https://${'a'.repeat(50)}.evil.example/`, 'x').risky).toMatch(/long string/)
    expect(linkInfo('https://example.com/docs/guides/getting-started/installation-on-windows', 'x').risky).toBeNull()
    expect(linkInfo('http://[::ffff:127.0.0.1]/', 'x').risky).toMatch(/local network/)
    expect(linkInfo('http://[::]/', 'x').risky).toMatch(/local network/)
    expect(linkInfo('http://2130706433/', 'x').risky).toMatch(/local network/)
    expect(remoteImageRisk('http://192.168.1.20/cam.jpg')).toMatch(/local network/)
    expect(remoteImageRisk(`https://tracker.example/p.png?d=${'a'.repeat(200)}`)).toMatch(/long string/)
    expect(remoteImageRisk('https://images.example/cat.png')).toBeNull()
  })

  it('classifies private hosts', () => {
    for (const h of ['localhost', 'vesper.localhost', '10.0.0.2', '172.20.1.1', '192.168.0.1', '169.254.1.1', '100.100.1.1', '[::1]', 'printer.local', 'nas']) expect(isPrivateHost(h)).toBe(true)
    for (const h of ['example.com', '8.8.8.8', '172.32.0.1', 'fcbarcelona.com']) expect(isPrivateHost(h)).toBe(false)
  })

  it('treats a trailing root dot as the same host (F13 second pass: "localhost." is still this PC)', () => {
    for (const h of ['localhost.', 'LOCALHOST.', 'a.localhost.', 'router.lan.', 'nas.local.', 'x.internal.', 'router.', 'localhost..']) expect(isPrivateHost(h), h).toBe(true)
    for (const h of ['example.com.', 'fcbarcelona.com.']) expect(isPrivateHost(h), h).toBe(false)
    for (const u of ['http://localhost./x', 'http://localhost.:9/admin', 'http://router.lan./', 'http://nas.local./cam', 'http://a.localhost./']) {
      expect(linkInfo(u, 'x').risky, u).toMatch(/local network/)
      expect(remoteImageRisk(u), u).toMatch(/local network/)
    }
    expect(linkInfo('https://example.com./x', 'x').risky).toBeNull()
  })
})
