import { describe, expect, it } from 'vitest'
import { ERRORS } from '@shared/errors'
import { buildQuery, buildUrl, fillPath, isAuthEndpoint, isMutating, splitEndpointKey } from '../../../src/web/lib/api.logic'
import { ApiErrorException, isApiError, parseErrorBody, statusToCode, toApiError } from '../../../src/web/lib/errors.logic'

describe('endpoint keys and URLs', () => {
  it('splits method and path', () => {
    expect(splitEndpointKey('PATCH /api/sessions/:uid')).toEqual({ method: 'PATCH', path: '/api/sessions/:uid' })
    expect(() => splitEndpointKey('FETCH /api/x')).toThrow()
    expect(() => splitEndpointKey('GET api/x')).toThrow()
  })

  it('marks mutating methods', () => {
    expect(isMutating('GET')).toBe(false)
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect(isMutating(m)).toBe(true)
  })

  it('fills and encodes path params', () => {
    expect(fillPath('/api/sessions/:uid/links/:shortId', { uid: 'a/b', shortId: 'K7Q2MX' })).toBe('/api/sessions/a%2Fb/links/K7Q2MX')
    expect(fillPath('/api/sessions/:uid/variants/:seq', { uid: 'u', seq: 12 })).toBe('/api/sessions/u/variants/12')
    expect(() => fillPath('/api/sessions/:uid', {})).toThrow(/uid/)
    expect(() => fillPath('/api/sessions/:uid', { uid: '' })).toThrow(/uid/)
  })

  it('builds queries, skipping empty values', () => {
    expect(buildQuery({ mode: 'latest', limit: 100, seq: undefined, q: null })).toBe('?mode=latest&limit=100')
    expect(buildQuery({ q: 'a b&c', on: true, ids: ['x', 'y'] })).toBe('?q=a%20b%26c&on=true&ids=x&ids=y')
    expect(buildQuery({})).toBe('')
    expect(buildQuery(undefined)).toBe('')
    expect(buildUrl('/api/sessions/:uid/messages', { uid: 'u1' }, { mode: 'before', seq: 5 })).toBe('/api/sessions/u1/messages?mode=before&seq=5')
  })

  it('knows which endpoints answer 401 for a wrong password', () => {
    expect(isAuthEndpoint('/api/auth/login')).toBe(true)
    expect(isAuthEndpoint('/api/bootstrap')).toBe(false)
  })
})

describe('error parsing', () => {
  it('reads the {error} envelope', () => {
    const e = parseErrorBody(409, { error: { code: 'session_busy', message: 'Busy!', retryable: true } })
    expect(e).toEqual({ code: 'session_busy', message: 'Busy!', retryable: true })
  })

  it('fills missing fields from the catalogue and keeps extras', () => {
    const e = parseErrorBody(400, { error: { code: 'validation', fields: { title: 'too long' } } })
    expect(e.message).toBe(ERRORS.validation.message)
    expect(e.retryable).toBe(false)
    expect(e.fields).toEqual({ title: 'too long' })
    const p = parseErrorBody(502, { error: { code: 'provider_auth', upstreamStatus: 401 } })
    expect(p).toMatchObject({ code: 'provider_auth', upstreamStatus: 401 })
  })

  it('takes retryAfter from the body, else from the Retry-After header', () => {
    expect(parseErrorBody(429, { error: { code: 'rate_limited', retryAfter: 30 } }, '5').retryAfter).toBe(30)
    expect(parseErrorBody(429, { error: { code: 'rate_limited' } }, '5').retryAfter).toBe(5)
    expect(parseErrorBody(429, null, '7')).toMatchObject({ code: 'rate_limited', retryAfter: 7 })
    expect(parseErrorBody(429, null, 'soon').retryAfter).toBeUndefined()
  })

  it('falls back to the status for unknown codes and non-JSON bodies', () => {
    expect(parseErrorBody(404, { error: { code: 'weird_code', message: 'x' } }).code).toBe('not_found')
    expect(parseErrorBody(500, '<html>proxy error</html>').code).toBe('internal')
    expect(parseErrorBody(401, null).code).toBe('unauthorized')
    expect(parseErrorBody(503, null).code).toBe('network')
    expect(parseErrorBody(501, undefined).message).toBe(ERRORS.not_implemented.message)
  })

  it('maps statuses', () => {
    expect(statusToCode(0)).toBe('network')
    expect(statusToCode(403)).toBe('forbidden')
    expect(statusToCode(413)).toBe('payload_too_large')
    expect(statusToCode(418)).toBe('internal')
  })

  it('wraps errors in ApiErrorException', () => {
    const ex = new ApiErrorException(parseErrorBody(403, { error: { code: 'sudo_required' } }), 403)
    expect(ex).toBeInstanceOf(Error)
    expect(ex.code).toBe('sudo_required')
    expect(ex.status).toBe(403)
    expect(ex.message).toBe(ERRORS.sudo_required.message)
    expect(isApiError(ex)).toBe(true)
    expect(isApiError(ex, 'sudo_required')).toBe(true)
    expect(isApiError(ex, 'forbidden')).toBe(false)
    expect(isApiError(new Error('x'))).toBe(false)
    expect(toApiError(new Error('x')).code).toBe('internal')
    expect(toApiError(ex).code).toBe('sudo_required')
  })
})
