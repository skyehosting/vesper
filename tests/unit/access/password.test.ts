/** Password rules, scrypt hashing and the scrypt queue (07 B15, research 06 §5.1). @R1 */
import { describe, expect, it } from 'vitest'
import { hashPassword, parseHash, passwordProblem, ScryptQueue, SCRYPT_DEFAULT, verifyPassword } from '@server/auth/password'

const FAST = { N: 2 ** 12, r: 8, p: 1 }

describe('password rules (NIST SP 800-63B-4)', () => {
  it('needs 15–1024 characters after NFKC, counted as characters not UTF-16 units', () => {
    expect(passwordProblem('short one')).toMatch(/at least 15/)
    expect(passwordProblem('fourteen chars')).toMatch(/at least 15/)
    expect(passwordProblem('plum tractor 19')).toBeNull()
    expect(passwordProblem('x'.repeat(1024 - 3) + 'abc')).toBeNull()
    expect(passwordProblem('y'.repeat(1020) + 'abcde')).toMatch(/at most 1024/)
    // 15 astral characters are 30 UTF-16 units but 15 characters.
    expect(passwordProblem('😀🎉🌙⭐🔥🍀🎈🐱🌈🍕🚀🎵🌻🦊🍩')).toBeNull()
    expect(passwordProblem('😀🎉🌙⭐🔥🍀🎈🐱🌈🍕🚀🎵🌻🦊')).toMatch(/at least 15/)
    // NFKC: full-width letters count like their ASCII forms.
    expect(passwordProblem('ｐａｓｓｗｏｒｄｐａｓｓｗｏｒｄ')).toMatch(/commonly used/)
    expect(passwordProblem(42)).toMatch(/Enter a password/)
    expect(passwordProblem('tab\there is not ok here')).toMatch(/control characters/)
  })

  it('rejects the bundled list, repetitions and keyboard/counting runs', () => {
    for (const bad of ['passwordpassword', 'Correct Horse Battery Staple', 'qwertyuiopasdfghjkl', 'iloveyouiloveyou']) expect(passwordProblem(bad), bad).toMatch(/commonly used/)
    for (const bad of ['aaaaaaaaaaaaaaaa', 'abcabcabcabcabcabc', 'vespervespervesper!'.slice(0, 18)]) expect(passwordProblem(bad), bad).toMatch(/repeats|commonly/)
    for (const bad of ['123456789012345', '987654321098765', 'mnopqrstuvwxyzab', 'asdfghjklzxcvbnm']) expect(passwordProblem(bad), bad).toMatch(/sequence/)
    for (const ok of ['my cat eats moonlight', 'Tr0ub4dor & 3 lanterns', 'violin harbor 1987 tide']) expect(passwordProblem(ok), ok).toBeNull()
  })
})

describe('scrypt', () => {
  it('stores scrypt$v=1 with params, salt and a 64-byte key; verifies in constant time', async () => {
    const h = await hashPassword('plum tractor 19', FAST)
    expect(h).toMatch(/^scrypt\$v=1\$N=4096,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(parseHash(h)?.key.length).toBe(64)
    expect(await verifyPassword('plum tractor 19', h)).toBe(true)
    expect(await verifyPassword('plum tractor 18', h)).toBe(false)
    // NFKC on both sides.
    expect(await verifyPassword('ｐｌｕｍ tractor 19', h)).toBe(true)
    expect(await hashPassword('plum tractor 19', FAST)).not.toBe(h)
    expect(await verifyPassword('plum tractor 19', null)).toBe(false)
    expect(await verifyPassword('plum tractor 19', 'garbage')).toBe(false)
  })

  it('refuses tampered parameters instead of allocating them', () => {
    expect(parseHash('scrypt$v=1$N=1073741824,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88))).toBeNull()
    expect(parseHash('scrypt$v=1$N=3000,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(88))).toBeNull()
  })

  it('the production parameters (N=2^17, maxmem 256 MiB) work on Electron’s Node', async () => {
    expect(SCRYPT_DEFAULT).toEqual({ N: 131072, r: 8, p: 1 })
    const t0 = performance.now()
    const h = await hashPassword('violin harbor 1987 tide')
    const ms = performance.now() - t0
    expect(h).toContain('N=131072,r=8,p=1')
    expect(await verifyPassword('violin harbor 1987 tide', h)).toBe(true)
    expect(ms).toBeLessThan(5000)
  })
})

describe('ScryptQueue', () => {
  it('runs one job at a time, holds 4 waiting, refuses the rest with rate_limited, drains to empty', async () => {
    const q = new ScryptQueue(4)
    let active = 0
    let peak = 0
    const job = () =>
      q.run(async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 20))
        active--
        return 'ok'
      })
    const jobs = Array.from({ length: 7 }, () => job().catch((e: { info?: { code: string; retryAfter?: number } }) => e.info))
    const results = await Promise.all(jobs)
    expect(peak).toBe(1)
    expect(results.filter((r) => r === 'ok')).toHaveLength(5)
    expect(results.filter((r) => typeof r === 'object' && r?.code === 'rate_limited')).toHaveLength(2)
    expect(q.size()).toBe(0)
  })

  it('a failing job releases the slot (leak check over 50 iterations)', async () => {
    const q = new ScryptQueue(4)
    for (let i = 0; i < 50; i++) {
      await expect(q.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
      expect(await q.run(async () => i)).toBe(i)
    }
    expect(q.size()).toBe(0)
  })
})
