/**
 * Slash commands (01 "Commands", 03 §5): parsing and a registry, generic over the context type so this file stays
 * DOM-free and unit-testable. The app's instance (with the real context) is in registry.ts.
 *
 * Grammar: "/name rest of the line". `name` is letters, digits and dashes (case-insensitive). "//text" escapes a
 * leading slash (sent as "/text"). An unknown "/word" is not a command: it is sent as normal text (03 §5).
 */

export interface ParsedCommand {
  /** Lower-cased command name without the slash. */
  name: string
  /** Everything after the name, trimmed. */
  args: string
  /** `args` split on whitespace, honouring "double quotes". */
  argv: string[]
}

const COMMAND_RE = /^\/([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]*))?$/

/** "/word args" → parts; anything else (plain text, "//escaped", "/ x", "/1") → null. */
export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trim()
  if (!t.startsWith('/') || t.startsWith('//')) return null
  const m = COMMAND_RE.exec(t)
  if (!m) return null
  const args = (m[2] ?? '').trim()
  return { name: m[1].toLowerCase(), args, argv: splitArgs(args) }
}

/** "//text" → "/text" (the escape for messages that start with a slash). Other text is returned unchanged. */
export function unescapeSlash(text: string): string {
  return text.trimStart().startsWith('//') ? text.replace('//', '/') : text
}

/** Whitespace split with "double quoted" runs kept together (quotes removed; \" inside quotes is a quote). */
export function splitArgs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  let has = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuote) {
      if (c === '\\' && s[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') inQuote = false
      else cur += c
      continue
    }
    if (c === '"') {
      inQuote = true
      has = true
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

export interface CommandDef<Ctx> {
  /** Name without the slash, lower-case: 'new', 'continue', 'prompt'. */
  name: string
  aliases?: string[]
  /** Usage of the arguments for help and the "/" menu, e.g. '[title]', '<#id>', 'on|off|status'. */
  args?: string
  /** One line of help. */
  help: string
  /** Hide from the menu/help when it doesn't apply (e.g. needs an open session). */
  available?(ctx: Ctx): boolean
  run(ctx: Ctx & { command: ParsedCommand }): void | Promise<void>
  /**
   * Argument suggestions for the "/" menu and the Ctrl+K palette (sessions-ui, additive): `args` is everything typed
   * after "/name " so far. Each suggestion's `insert` replaces the whole argument text.
   */
  completeArgs?(ctx: Ctx, args: string, signal?: AbortSignal): ArgSuggestion[] | Promise<ArgSuggestion[]>
}

/** One argument completion: `insert` is the full argument text to put after "/name ". */
export interface ArgSuggestion {
  insert: string
  label: string
  description?: string
  /** True when choosing it should run the command right away (nothing more to type). */
  final?: boolean
}

/**
 * Where the caret is in a partially typed command line: still typing the name ("/con") or typing arguments
 * ("/continue #K7"). Null when the text is not a command line at all.
 */
export function commandLineState(text: string): { stage: 'name'; prefix: string } | { stage: 'args'; name: string; args: string } | null {
  const t = text.trimStart()
  if (!t.startsWith('/') || t.startsWith('//')) return null
  const m = /^\/([A-Za-z][A-Za-z0-9-]*)?(\s+([\s\S]*))?$/.exec(t)
  if (!m) return null
  if (m[2] === undefined) return { stage: 'name', prefix: (m[1] ?? '').toLowerCase() }
  if (!m[1]) return null
  return { stage: 'args', name: m[1].toLowerCase(), args: m[3] ?? '' }
}

export interface CommandRegistry<Ctx> {
  register(def: CommandDef<Ctx>): () => void
  get(name: string): CommandDef<Ctx> | undefined
  list(ctx?: Ctx): CommandDef<Ctx>[]
  /** Parse + look up. Null = not a (known) command → send the text as a message. */
  resolve(text: string): { def: CommandDef<Ctx>; command: ParsedCommand } | null
  /** Names/aliases starting with `prefix` (for the "/" menu). */
  complete(prefix: string, ctx?: Ctx): CommandDef<Ctx>[]
}

const NAME_RE = /^[a-z][a-z0-9-]*$/

export function createCommandRegistry<Ctx>(): CommandRegistry<Ctx> {
  const byName = new Map<string, CommandDef<Ctx>>()
  const defs = new Set<CommandDef<Ctx>>()

  const register = (def: CommandDef<Ctx>): (() => void) => {
    const names = [def.name, ...(def.aliases ?? [])]
    for (const n of names) {
      if (!NAME_RE.test(n)) throw new Error(`invalid command name "${n}"`)
      const prev = byName.get(n)
      if (prev && prev !== def) throw new Error(`command "/${n}" is already registered`)
    }
    for (const n of names) byName.set(n, def)
    defs.add(def)
    return () => {
      for (const n of names) if (byName.get(n) === def) byName.delete(n)
      defs.delete(def)
    }
  }

  const visible = (def: CommandDef<Ctx>, ctx?: Ctx): boolean => !ctx || !def.available || def.available(ctx)

  return {
    register,
    get: (name) => byName.get(name.toLowerCase()),
    list: (ctx) => [...defs].filter((d) => visible(d, ctx)).sort((a, b) => a.name.localeCompare(b.name)),
    resolve: (text) => {
      const command = parseCommand(text)
      if (!command) return null
      const def = byName.get(command.name)
      return def ? { def, command } : null
    },
    complete: (prefix, ctx) => {
      const p = prefix.replace(/^\//, '').toLowerCase()
      return [...defs]
        .filter((d) => visible(d, ctx) && [d.name, ...(d.aliases ?? [])].some((n) => n.startsWith(p)))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  }
}
