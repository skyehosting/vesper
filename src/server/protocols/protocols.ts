/**
 * The protocols file (R9, 07 C1): `protocols.md` in the roaming data dir when the owner edited it, else the default
 * shipped in src/shared/protocols.default.md. Epochs freeze the text they were created with, so saving never changes a
 * running conversation — new epochs (new sessions, "Apply to this session now", rollovers) pick it up.
 *
 * Validation only WARNS (the owner may write whatever they like): unknown or malformed placeholders, unbalanced mode
 * blocks, undocumented memory functions, a missing tone instruction.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import DEFAULT_PROTOCOLS from '@shared/protocols.default.md?raw'
import type { Log } from '../services'

/** Placeholders the renderer fills in (07 C1), plus the generated function docs (shared/memoryFunctions.ts). */
export const PROTOCOL_PLACEHOLDERS = ['assistant_name', 'user_name', 'session_id', 'tones', 'tone_instruction', 'native_function_docs', 'text_function_docs'] as const
export const PROTOCOL_BLOCKS = ['native_mode', 'text_mode'] as const
export const MAX_PROTOCOLS_CHARS = 200_000

export const DEFAULT_PROTOCOLS_TEXT: string = DEFAULT_PROTOCOLS.replace(/\r\n/g, '\n')

export function protocolsHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const isPlaceholder = (n: string): boolean => (PROTOCOL_PLACEHOLDERS as readonly string[]).includes(n)
const isBlock = (n: string): boolean => (PROTOCOL_BLOCKS as readonly string[]).includes(n)

/** Human-readable warnings for a protocols text (empty = fine). */
export function validateProtocols(text: string): string[] {
  const warnings: string[] = []
  const add = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w)
  }
  const stack: string[] = []
  /** Which function-docs placeholders appear where they will actually be rendered. */
  const docsIn = { native: false, text: false }
  const tokenRe = /\{\{([^{}]*)\}\}/g
  let m: RegExpExecArray | null
  while ((m = tokenRe.exec(text))) {
    const inner = m[1].trim()
    if (inner.startsWith('#') || inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      if (!isBlock(name)) {
        add(`Unknown block {{${inner}}}: only {{#native_mode}}…{{/native_mode}} and {{#text_mode}}…{{/text_mode}} exist.`)
        continue
      }
      if (inner.startsWith('#')) {
        if (stack.length) add(`{{#${name}}} is inside {{#${stack[stack.length - 1]}}}; mode blocks can't be nested.`)
        stack.push(name)
      } else if (stack[stack.length - 1] === name) stack.pop()
      else add(`{{/${name}}} closes a block that isn't open.`)
      continue
    }
    if (!isPlaceholder(inner)) {
      add(`Unknown placeholder {{${inner}}}: it will be sent to the AI exactly as written.`)
      continue
    }
    if (inner === 'native_function_docs' && !stack.includes('text_mode')) docsIn.native = true
    if (inner === 'text_function_docs' && !stack.includes('native_mode')) docsIn.text = true
  }
  for (const open of stack) add(`{{#${open}}} is never closed with {{/${open}}}.`)

  const withoutTokens = text.replace(tokenRe, '')
  if (withoutTokens.includes('{{') || withoutTokens.includes('}}')) add('A {{ or }} has no partner, so a placeholder is broken.')
  const single = /(?<!\{)\{\s*(assistant_name|user_name|session_id|tones|tone_instruction|native_function_docs|text_function_docs)\s*\}(?!\})/.exec(withoutTokens)
  if (single) add(`{${single[1]}} needs double braces: {{${single[1]}}}.`)

  // The functions must be documented for the model in each mode (R9): the generated docs or a hand-written mention.
  const mentions = /memory_search/.test(withoutTokens) && /memory_recall/.test(withoutTokens)
  if (!docsIn.text && !mentions) add('[memory_search] and [memory_recall] are not documented for text mode: add {{text_function_docs}} inside {{#text_mode}}…{{/text_mode}}.')
  if (!docsIn.native && !mentions) add('The memory tools are not described for native mode: add {{native_function_docs}} inside {{#native_mode}}…{{/native_mode}}.')
  if (!/\{\{\s*tone_instruction\s*\}\}/.test(text)) add('{{tone_instruction}} is missing, so the AI is not told how to tag its tone for the voice.')
  return warnings
}

export interface ProtocolsState {
  text: string
  hash: string
  isDefault: boolean
}

/** Reads protocols.md (cached by mtime), writes it atomically, resets by removing it. */
export class ProtocolsStore {
  private cache: { mtimeMs: number; size: number; state: ProtocolsState } | null = null
  private readonly defaultState: ProtocolsState = { text: DEFAULT_PROTOCOLS_TEXT, hash: protocolsHash(DEFAULT_PROTOCOLS_TEXT), isDefault: true }

  constructor(
    readonly file: string,
    private readonly log: Log
  ) {}

  get(): ProtocolsState {
    let st: fs.Stats
    try {
      st = fs.statSync(this.file)
    } catch {
      this.cache = null
      return this.defaultState
    }
    if (this.cache && this.cache.mtimeMs === st.mtimeMs && this.cache.size === st.size) return this.cache.state
    try {
      const text = fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n')
      const state: ProtocolsState = { text, hash: protocolsHash(text), isDefault: text === DEFAULT_PROTOCOLS_TEXT }
      this.cache = { mtimeMs: st.mtimeMs, size: st.size, state }
      return state
    } catch (e) {
      // An unreadable file must not take the AI's instructions away: fall back to the default and say so in the log.
      this.log.warn('protocols.md unreadable; using the default', { error: e })
      return this.defaultState
    }
  }

  /** Save the owner's text (atomic temp + rename). */
  put(text: string): ProtocolsState {
    const normalized = text.replace(/\r\n/g, '\n')
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, normalized, 'utf8')
    fs.renameSync(tmp, this.file)
    this.cache = null
    return this.get()
  }

  /** Back to the shipped default: the file is removed, so later app updates of the default apply again. */
  reset(): ProtocolsState {
    fs.rmSync(this.file, { force: true })
    this.cache = null
    return this.defaultState
  }
}
