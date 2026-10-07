import { describe, expect, it } from 'vitest'
import { compilePattern, isAppPath, matchPattern, matchRoute, splitPath } from '../../../src/web/lib/router.logic'

describe('route patterns', () => {
  it('matches static and root paths', () => {
    expect(matchPattern('/', '/')).toEqual({})
    expect(matchPattern('/', '')).toEqual({})
    expect(matchPattern('/setup', '/setup')).toEqual({})
    expect(matchPattern('/setup', '/setup/')).toEqual({})
    expect(matchPattern('/setup', '/setupx')).toBeNull()
    expect(matchPattern('/', '/s/abc')).toBeNull()
  })

  it('extracts and decodes params', () => {
    expect(matchPattern('/s/:uid', '/s/3f2a-11')).toEqual({ uid: '3f2a-11' })
    expect(matchPattern('/s/:uid', '/s/a%20b')).toEqual({ uid: 'a b' })
    expect(matchPattern('/s/:uid', '/s/')).toBeNull()
    expect(matchPattern('/s/:uid', '/s/a/b')).toBeNull()
  })

  it('supports a trailing optional param', () => {
    expect(matchPattern('/settings/:section?', '/settings')).toEqual({ section: undefined })
    expect(matchPattern('/settings/:section?', '/settings/voice-out')).toEqual({ section: 'voice-out' })
    expect(matchPattern('/settings/:section?', '/settings/a/b')).toBeNull()
    expect(() => compilePattern('/a/:b?/c')).toThrow(/optional/)
  })

  it('treats malformed encoding as no match', () => {
    expect(matchPattern('/s/:uid', '/s/%E0%A4%A')).toBeNull()
  })

  it('escapes regex characters in static segments', () => {
    expect(matchPattern('/a.b', '/a.b')).toEqual({})
    expect(matchPattern('/a.b', '/axb')).toBeNull()
  })

  it('first matching route wins', () => {
    const routes = [{ path: '/' }, { path: '/s/:uid' }, { path: '/settings/:section?' }]
    expect(matchRoute(routes, '/s/x')?.route.path).toBe('/s/:uid')
    expect(matchRoute(routes, '/settings')?.route.path).toBe('/settings/:section?')
    expect(matchRoute(routes, '/nope')).toBeNull()
  })
})

describe('paths', () => {
  it('splits path, search and hash', () => {
    expect(splitPath('/s/x?a=1#h')).toEqual({ pathname: '/s/x', search: '?a=1', hash: '#h' })
    expect(splitPath('?q')).toEqual({ pathname: '/', search: '?q', hash: '' })
  })

  it('only accepts same-app absolute paths', () => {
    expect(isAppPath('/s/x')).toBe(true)
    expect(isAppPath('//evil.example/x')).toBe(false)
    expect(isAppPath('/\\evil.example')).toBe(false)
    expect(isAppPath('https://evil.example')).toBe(false)
    expect(isAppPath('javascript:alert(1)')).toBe(false)
  })
})
