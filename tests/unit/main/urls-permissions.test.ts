import { describe, expect, it } from 'vitest'
import { decidePermission } from '../../../src/main/permissions'
import { isHexColor, isSameOrigin, originOf, validateExternalUrl } from '../../../src/main/urls'

const OWN = 'http://127.0.0.1:41730'

describe('originOf / isSameOrigin', () => {
  it('compares scheme, host and port exactly', () => {
    expect(originOf('http://127.0.0.1:41730/chat?x=1#y')).toBe(OWN)
    expect(isSameOrigin('http://127.0.0.1:41730/settings', OWN)).toBe(true)
    expect(isSameOrigin('http://127.0.0.1:41731/', OWN)).toBe(false)
    expect(isSameOrigin('https://127.0.0.1:41730/', OWN)).toBe(false)
    expect(isSameOrigin('http://localhost:41730/', OWN)).toBe(false)
    expect(isSameOrigin('http://vesper.localhost:41730/', OWN)).toBe(false)
    expect(isSameOrigin('http://127.0.0.1:41730@evil.example/', OWN)).toBe(false)
  })
  it('never matches without an allowed origin or with opaque URLs', () => {
    expect(isSameOrigin('http://127.0.0.1:41730/', null)).toBe(false)
    expect(originOf('data:text/html,hi')).toBeNull()
    expect(originOf('about:blank')).toBeNull()
    expect(originOf('not a url')).toBeNull()
    expect(originOf(undefined)).toBeNull()
  })
})

describe('validateExternalUrl', () => {
  it('allows http, https and mailto', () => {
    expect(validateExternalUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c')
    expect(validateExternalUrl('http://example.com')).toBe('http://example.com/')
    expect(validateExternalUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
    expect(validateExternalUrl('HTTPS://EXAMPLE.COM/')).toBe('https://example.com/')
  })
  it('refuses schemes that launch programs or read files', () => {
    for (const u of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'ms-settings:privacy-microphone',
      'vbscript:msgbox',
      'data:text/html,<script>1</script>',
      '\\\\server\\share\\x.exe',
      'search-ms:query=x',
      'ftp://example.com/',
      'mailto:'
    ]) {
      expect(validateExternalUrl(u), u).toBeNull()
    }
  })
  it('refuses credentials, whitespace, control characters and non-strings', () => {
    expect(validateExternalUrl('https://user:pass@example.com/')).toBeNull()
    expect(validateExternalUrl('https://google.com@evil.example/')).toBeNull()
    expect(validateExternalUrl(' https://example.com')).toBeNull()
    expect(validateExternalUrl('https://exa\nmple.com')).toBeNull()
    expect(validateExternalUrl('https://example.com/\u0000')).toBeNull()
    expect(validateExternalUrl(42)).toBeNull()
    expect(validateExternalUrl('')).toBeNull()
    expect(validateExternalUrl(`https://example.com/${'a'.repeat(5000)}`)).toBeNull()
  })
})

describe('isHexColor', () => {
  it('accepts hex colors only', () => {
    for (const c of ['#07070d', '#FFF', '#f3f1fbcc', '#abcd']) expect(isHexColor(c), c).toBe(true)
    for (const c of ['red', 'rgb(0,0,0)', '#12345', '07070d', '#ggg', '', null, 7]) expect(isHexColor(c), String(c)).toBe(false)
  })
})

describe('decidePermission', () => {
  const q = (permission: string, requester: string | null, mediaTypes?: string[]) =>
    decidePermission({ permission, requester, allowedOrigin: OWN, mediaTypes })

  it('allows the microphone for our origin only, never the camera', () => {
    expect(q('media', `${OWN}/talk`, ['audio'])).toBe(true)
    expect(q('media', OWN, ['audio', 'video'])).toBe(false)
    expect(q('media', OWN, ['video'])).toBe(false)
    expect(q('media', OWN, [])).toBe(false)
    expect(q('media', OWN)).toBe(false)
    expect(q('media', OWN, ['unknown'])).toBe(false)
    expect(q('media', 'http://127.0.0.1:5173/', ['audio'])).toBe(false)
    expect(q('media', 'https://evil.example/', ['audio'])).toBe(false)
  })
  it('allows sanitized clipboard writes and fullscreen for our origin', () => {
    expect(q('clipboard-sanitized-write', `${OWN}/`)).toBe(true)
    expect(q('fullscreen', `${OWN}/`)).toBe(true)
    expect(q('fullscreen', 'https://evil.example/')).toBe(false)
  })
  it('denies everything else', () => {
    for (const p of ['notifications', 'geolocation', 'clipboard-read', 'display-capture', 'hid', 'usb', 'serial', 'openExternal', 'midi', 'pointerLock', 'unknown']) {
      expect(q(p, OWN), p).toBe(false)
    }
  })
  it('denies everything before the server runs', () => {
    expect(decidePermission({ permission: 'fullscreen', requester: OWN, allowedOrigin: null })).toBe(false)
    expect(decidePermission({ permission: 'media', requester: null, allowedOrigin: OWN, mediaTypes: ['audio'] })).toBe(false)
  })
})
