import { describe, expect, it, vi } from 'vitest'
import { createCommandRegistry, parseCommand, splitArgs, unescapeSlash } from '../../../src/web/lib/commands/registry.logic'

describe('parseCommand', () => {
  it('parses "/word args"', () => {
    expect(parseCommand('/new My trip')).toEqual({ name: 'new', args: 'My trip', argv: ['My', 'trip'] })
    expect(parseCommand('  /Memory   off  ')).toEqual({ name: 'memory', args: 'off', argv: ['off'] })
    expect(parseCommand('/id')).toEqual({ name: 'id', args: '', argv: [] })
  })

  it('keeps multi-line arguments', () => {
    expect(parseCommand('/prompt You are terse.\nAnswer in English.')?.args).toBe('You are terse.\nAnswer in English.')
  })

  it('rejects what is not a command', () => {
    for (const t of ['hello', '', '/', '/ new', '/1abc', '//new', 'a /new', '/n!ew']) expect(parseCommand(t)).toBeNull()
  })

  it('needs whitespace after the name', () => {
    expect(parseCommand('/new:thing')).toBeNull()
    expect(parseCommand('/continue #K7Q2MX')?.argv).toEqual(['#K7Q2MX'])
  })
})

describe('splitArgs', () => {
  it('splits on whitespace and honours double quotes', () => {
    expect(splitArgs('use "Daily journal" now')).toEqual(['use', 'Daily journal', 'now'])
    expect(splitArgs('a  b\tc')).toEqual(['a', 'b', 'c'])
    expect(splitArgs('"say \\"hi\\""')).toEqual(['say "hi"'])
    expect(splitArgs('""')).toEqual([''])
    expect(splitArgs('')).toEqual([])
  })
})

describe('unescapeSlash', () => {
  it('turns a leading // into /', () => {
    expect(unescapeSlash('//etc/hosts is a file')).toBe('/etc/hosts is a file')
    expect(unescapeSlash('a // b')).toBe('a // b')
  })
})

describe('command registry', () => {
  interface Ctx {
    session: string | null
  }

  it('registers, resolves (case-insensitive, aliases) and unregisters', async () => {
    const reg = createCommandRegistry<Ctx>()
    const run = vi.fn()
    const off = reg.register({ name: 'title', aliases: ['rename'], args: '<text>', help: 'Rename', run })
    const hit = reg.resolve('/TITLE Hello there')
    expect(hit?.def.name).toBe('title')
    expect(hit?.command.args).toBe('Hello there')
    expect(reg.resolve('/rename x')?.def.name).toBe('title')
    await hit?.def.run({ session: 's1', command: hit.command })
    expect(run).toHaveBeenCalledWith({ session: 's1', command: { name: 'title', args: 'Hello there', argv: ['Hello', 'there'] } })
    off()
    expect(reg.resolve('/title x')).toBeNull()
    expect(reg.list()).toEqual([])
  })

  it('treats unknown commands as plain text', () => {
    const reg = createCommandRegistry<Ctx>()
    expect(reg.resolve('/unknown thing')).toBeNull()
  })

  it('refuses duplicate names and invalid names', () => {
    const reg = createCommandRegistry<Ctx>()
    reg.register({ name: 'new', help: '', run: () => undefined })
    expect(() => reg.register({ name: 'new', help: '', run: () => undefined })).toThrow(/already registered/)
    expect(() => reg.register({ name: 'Bad Name', help: '', run: () => undefined })).toThrow(/invalid/)
  })

  it('lists and completes only available commands, sorted', () => {
    const reg = createCommandRegistry<Ctx>()
    reg.register({ name: 'new', help: '', run: () => undefined })
    reg.register({ name: 'link', help: '', available: (c) => c.session !== null, run: () => undefined })
    reg.register({ name: 'links', help: '', available: (c) => c.session !== null, run: () => undefined })
    expect(reg.list({ session: null }).map((d) => d.name)).toEqual(['new'])
    expect(reg.list({ session: 'x' }).map((d) => d.name)).toEqual(['link', 'links', 'new'])
    expect(reg.complete('/li', { session: 'x' }).map((d) => d.name)).toEqual(['link', 'links'])
    expect(reg.complete('li', { session: null })).toEqual([])
  })
})
